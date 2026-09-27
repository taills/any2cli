import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { CredentialStore } from '../../auth/token-store.js';
import { convertMcpServers } from '../../config/import-mcp-json.js';
import { parseTarget, type OpenApiTarget, type Target } from '../../config/schema.js';
import { getTarget, redactTarget, updateConfig, type ConfigUpdate, type LoadedConfig, withTarget, withoutTarget } from '../../config/store.js';
import { CliError } from '../../core/errors.js';
import { assertTargetName } from '../../core/names.js';
import type { OpenApiManifest } from '../../openapi/compile.js';
import { normalizeSource } from '../../openapi/load.js';
import { readManifest, removeManifest } from '../../openapi/manifest-store.js';
import { compileOpenApiTarget } from '../../targets/open.js';
import { addAuthOptions, buildAuth, hasLiteralSecret, type AuthFlags } from '../auth-options.js';
import type { Context } from '../context.js';
import { table } from '../output.js';

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function parsePairs(values: string[] | undefined, separator: '=' | ':', flag: string): Record<string, string> {
  return Object.fromEntries(
    (values ?? []).map((entry) => {
      const index = entry.indexOf(separator);
      if (index <= 0) throw new CliError('USAGE', `${flag} expects NAME${separator}VALUE, got "${entry}"`);
      return [entry.slice(0, index).trim(), entry.slice(index + 1).trim()];
    }),
  );
}

async function saveNewTarget(ctx: Context, name: string, raw: Record<string, unknown>, force: boolean): Promise<Target> {
  assertTargetName(name);
  const target = parseTarget(raw, name);
  await updateConfig(ctx.paths.configFile, (config) => {
    if (config.targets[name] && !force) {
      throw new CliError('USAGE', `Target "${name}" already exists`, { hint: 'Use --force to overwrite it' });
    }
    return { raw: withTarget(config.raw, name, raw), result: undefined };
  });
  return target;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && !(typeof item === 'object' && item !== null && Object.keys(item).length === 0)),
  );
}

interface AddMcpFlags extends AuthFlags {
  transport?: string;
  env?: string[];
  header?: string[];
  cwd?: string;
  description?: string;
  force?: boolean;
}

function registerAddMcp(add: Command, ctx: () => Context): void {
  addAuthOptions(
    add
      .command('mcp')
      .description('Add an MCP server: a URL (Streamable HTTP / SSE) or a command to run over stdio')
      .argument('<name>', 'target name')
      .argument('<command-or-url>', 'server URL, or the command that starts a stdio server')
      .argument('[args...]', 'arguments for the stdio command (put them after --)')
      .option('-t, --transport <type>', 'for URLs: http (Streamable HTTP) or sse; default: sse if the path ends in /sse')
      .option('-e, --env <KEY=VALUE>', 'environment variable for the stdio server (repeatable)', collect)
      .option('-H, --header <"Name: value">', 'HTTP header for remote servers (repeatable)', collect)
      .option('--cwd <dir>', 'working directory for the stdio server')
      .option('-d, --description <text>', 'description shown in `any2cli list` and generated skills')
      .option('-f, --force', 'overwrite an existing target'),
  )
    .addHelpText('after', '\nExamples:\n  any2cli add mcp fs -- npx -y @modelcontextprotocol/server-filesystem ~/src\n  any2cli add mcp linear https://mcp.linear.app/mcp --oauth\n  any2cli add mcp internal https://mcp.example.com/sse -H "Authorization: Bearer ${TOKEN}"')
    .action(async (name: string, commandOrUrl: string, args: string[], flags: AddMcpFlags) => {
      const context = ctx();
      const isUrl = /^https?:\/\//i.test(commandOrUrl);
      let raw: Record<string, unknown>;
      if (isUrl) {
        const transport = flags.transport ?? (/\/sse\/?$/.test(new URL(commandOrUrl).pathname) ? 'sse' : 'http');
        if (!['http', 'sse'].includes(transport)) throw new CliError('USAGE', `Invalid --transport "${transport}" (use http or sse)`);
        raw = compact({
          type: transport,
          url: commandOrUrl,
          headers: parsePairs(flags.header, ':', '--header'),
          auth: buildAuth(flags, 'mcp'),
          description: flags.description,
        });
      } else {
        if (buildAuth(flags, 'mcp')) throw new CliError('USAGE', 'Auth options apply to remote (URL) servers only; use --env for stdio servers');
        raw = compact({
          type: 'stdio',
          command: commandOrUrl,
          args: args.length > 0 ? args : undefined,
          env: parsePairs(flags.env, '=', '--env'),
          cwd: flags.cwd,
          description: flags.description,
        });
      }
      const target = await saveNewTarget(context, name, raw, flags.force === true);
      if (hasLiteralSecret(flags)) context.printer.info('tip: pass secrets as "${ENV_VAR}" so they are read from the environment instead of stored in the config');
      const next = target.type !== 'stdio' && target.auth?.type === 'mcp-oauth' ? `any2cli auth login ${name}` : `any2cli tools ${name}`;
      context.printer.result({ added: name, target: redactTarget(target) }, `Added ${target.type} target "${name}". Next: ${next}`);
    });
}

interface AddOpenApiFlags extends AuthFlags {
  baseUrl?: string;
  header?: string[];
  include?: string;
  exclude?: string;
  description?: string;
  force?: boolean;
}

function securityHint(name: string, manifest: OpenApiManifest, target: OpenApiTarget): string | undefined {
  if (target.auth || manifest.security.length === 0) return undefined;
  const kinds = manifest.security.map((scheme) => (scheme.type === 'apiKey' ? `apiKey(${scheme.in}:${scheme.paramName})` : scheme.type)).join(', ');
  return `The spec declares auth (${kinds}). Re-run with --force plus --oauth --client-id <id>, --bearer, or --api-key to configure it for "${name}".`;
}

/** OAuth endpoints taken from a spec decide where the user's credentials are sent, so show them. */
function oauthEndpointNotice(target: OpenApiTarget): string[] {
  const auth = target.auth;
  if (auth?.type !== 'oauth2') return [];
  const endpoints = [
    ['authorization', auth.authorizationUrl],
    ['token', auth.tokenUrl],
    ['device', auth.deviceAuthorizationUrl],
    ['discovery', auth.discoveryUrl],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (endpoints.length === 0) return [];
  return ['OAuth2 endpoints (check they belong to the API provider before logging in):', ...endpoints.map(([kind, url]) => `  ${kind}: ${url}`)];
}

function registerAddOpenApi(add: Command, ctx: () => Context): void {
  addAuthOptions(
    add
      .command('openapi')
      .description('Add a REST API from an OpenAPI 3.x / Swagger 2.0 document (URL or file, JSON or YAML)')
      .argument('<name>', 'target name')
      .argument('<spec>', 'URL or path of the OpenAPI document')
      .option('--base-url <url>', 'override the server URL from the spec')
      .option('-H, --header <"Name: value">', 'extra HTTP header for every request (repeatable)', collect)
      .option('--include <patterns>', 'only expose matching operations (comma separated; globs; tag:<name>)')
      .option('--exclude <patterns>', 'hide matching operations (comma separated; globs; tag:<name>)')
      .option('-d, --description <text>', 'description shown in `any2cli list` and generated skills')
      .option('-f, --force', 'overwrite an existing target'),
  )
    .addHelpText('after', '\nExamples:\n  any2cli add openapi petstore https://petstore3.swagger.io/api/v3/openapi.json\n  any2cli add openapi github ./api.github.com.yaml --include "tag:repos" --bearer "${GITHUB_TOKEN}"\n  any2cli add openapi acme https://api.acme.dev/openapi.json --oauth --client-id my-client')
    .action(async (name: string, spec: string, flags: AddOpenApiFlags) => {
      const context = ctx();
      assertTargetName(name);
      const source = normalizeSource(spec, context.runtime.cwd);
      const base = compact({
        type: 'openapi',
        spec: source,
        baseUrl: flags.baseUrl,
        headers: parsePairs(flags.header, ':', '--header'),
        include: flags.include?.split(',').map((item) => item.trim()).filter(Boolean),
        exclude: flags.exclude?.split(',').map((item) => item.trim()).filter(Boolean),
        description: flags.description,
      });
      const manifest = await compileOpenApiTarget(name, parseTarget(base, name) as OpenApiTarget, context.paths);
      // Pin the server URL so a later change to the (possibly remote) spec cannot redirect credentials elsewhere.
      const raw = compact({ ...base, baseUrl: flags.baseUrl ?? manifest.baseUrl, auth: buildAuth(flags, 'openapi', manifest.security) });
      const target = (await saveNewTarget(context, name, raw, flags.force === true)) as OpenApiTarget;
      if (hasLiteralSecret(flags)) context.printer.info('tip: pass secrets as "${ENV_VAR}" so they are read from the environment instead of stored in the config');
      const hint = securityHint(name, manifest, target);
      if (hint) context.printer.info(hint);
      oauthEndpointNotice(target).forEach((line) => context.printer.info(line));
      const baseUrl = target.baseUrl ?? '(none — set --base-url)';
      const next = target.auth?.type === 'oauth2' && target.auth.flow !== 'client_credentials' ? `any2cli auth login ${name}` : `any2cli tools ${name}`;
      context.printer.result(
        { added: name, title: manifest.title, operations: manifest.operations.length, baseUrl, target: redactTarget(target) },
        `Added "${name}": ${manifest.title} — ${manifest.operations.length} operations, base URL ${baseUrl}. Next: ${next}`,
      );
    });
}

function describeTarget(target: Target): string {
  if (target.description) return target.description;
  if (target.type === 'stdio') return [target.command, ...target.args].join(' ');
  if (target.type === 'openapi') return target.spec;
  return target.url;
}

interface Skipped {
  name: string;
  reason: string;
}

function mergeImported(
  config: LoadedConfig,
  targets: Record<string, unknown>,
  skipped: Skipped[],
  force: boolean,
): ConfigUpdate<{ imported: string[]; allSkipped: Skipped[] }> {
  const imported: string[] = [];
  const allSkipped = [...skipped];
  let raw = config.raw;
  for (const [name, value] of Object.entries(targets)) {
    try {
      assertTargetName(name);
      parseTarget(value, name);
    } catch (error) {
      allSkipped.push({ name, reason: (error as Error).message });
      continue;
    }
    if (config.targets[name] && !force) {
      allSkipped.push({ name, reason: 'already exists (use --force)' });
      continue;
    }
    raw = withTarget(raw, name, value);
    imported.push(name);
  }
  return { raw, result: { imported, allSkipped } };
}

function registerManagement(program: Command, ctx: () => Context): void {
  program
    .command('list')
    .alias('ls')
    .description('List configured targets')
    .action(async () => {
      const context = ctx();
      const config = await context.loadConfig();
      const entries = Object.entries(config.targets);
      const text =
        entries.length === 0
          ? 'No targets yet. Add one with `any2cli add mcp ...` or `any2cli add openapi ...`'
          : table(entries.map(([name, target]) => [name, target.type, describeTarget(target)]));
      context.printer.result(
        entries.map(([name, target]) => ({ name, type: target.type, description: describeTarget(target), auth: target.type === 'stdio' ? undefined : target.auth?.type })),
        text,
      );
    });

  program
    .command('show')
    .description('Show a target definition (secrets masked)')
    .argument('<name>')
    .action(async (name: string) => {
      const context = ctx();
      const target = getTarget(await context.loadConfig(), name);
      const manifest = target.type === 'openapi' ? await readManifest(context.paths.cacheDir, name) : undefined;
      const summary = manifest
        ? { title: manifest.title, baseUrl: manifest.baseUrl, operations: manifest.operations.length, compiledAt: manifest.compiledAt, security: manifest.security }
        : undefined;
      context.printer.data({ name, ...redactTarget(target), ...(summary ? { spec: summary } : {}) });
    });

  program
    .command('remove')
    .alias('rm')
    .description('Remove a target, its cached spec and stored credentials')
    .argument('<name>')
    .action(async (name: string) => {
      const context = ctx();
      await updateConfig(context.paths.configFile, (config) => {
        getTarget(config, name);
        return { raw: withoutTarget(config.raw, name), result: undefined };
      });
      await removeManifest(context.paths.cacheDir, name);
      await new CredentialStore(context.paths.credentialsDir).remove(name);
      context.printer.result({ removed: name }, `Removed "${name}"`);
    });

  program
    .command('refresh')
    .description('Re-download and recompile the OpenAPI spec of a target')
    .argument('<name>')
    .action(async (name: string) => {
      const context = ctx();
      const target = getTarget(await context.loadConfig(), name);
      if (target.type !== 'openapi') throw new CliError('USAGE', `"${name}" is an MCP target; MCP tools are always fetched live`);
      const manifest = await compileOpenApiTarget(name, target, context.paths);
      if (target.baseUrl && manifest.baseUrl && manifest.baseUrl !== target.baseUrl) {
        context.printer.info(
          `note: the spec now declares server ${manifest.baseUrl}; requests still go to the configured ${target.baseUrl}. ` +
            `To switch, re-add the target with --base-url ${manifest.baseUrl} --force.`,
        );
      }
      context.printer.result(
        { refreshed: name, operations: manifest.operations.length },
        `Refreshed "${name}": ${manifest.operations.length} operations`,
      );
    });

  program
    .command('import')
    .description('Import MCP servers from a Claude Desktop / Claude Code / Cursor / VS Code JSON config')
    .argument('<file>', 'e.g. ~/Library/Application Support/Claude/claude_desktop_config.json, .mcp.json, ~/.cursor/mcp.json')
    .option('--prefix <prefix>', 'prefix for imported target names', '')
    .option('-f, --force', 'overwrite existing targets with the same name')
    .action(async (file: string, flags: { prefix: string; force?: boolean }) => {
      const context = ctx();
      let document: unknown;
      try {
        document = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        throw new CliError('USAGE', `Cannot read ${file}: ${(error as Error).message}`);
      }
      const { targets, skipped } = convertMcpServers(document, flags.prefix);
      const { imported, allSkipped } = await updateConfig(context.paths.configFile, (config) =>
        mergeImported(config, targets, skipped, flags.force === true),
      );
      const lines = [`Imported ${imported.length} target(s): ${imported.join(', ') || '-'}`, ...allSkipped.map((item) => `  skipped ${item.name}: ${item.reason}`)];
      context.printer.result({ imported, skipped: allSkipped }, lines.join('\n'));
    });
}

export function registerTargetCommands(program: Command, ctx: () => Context): void {
  const add = program.command('add').description('Add a target (MCP server or OpenAPI spec)');
  registerAddMcp(add, ctx);
  registerAddOpenApi(add, ctx);
  registerManagement(program, ctx);
}
