import type { Command } from 'commander';
import { loginMcp, loginOAuth2 } from '../../auth/login.js';
import { isExpired } from '../../auth/resolve.js';
import { CredentialStore, type CredentialRecord } from '../../auth/token-store.js';
import { OAUTH2_FLOWS, type OAuth2Config, type StdioTarget, type Target } from '../../config/schema.js';
import { getTarget } from '../../config/store.js';
import { CliError } from '../../core/errors.js';
import type { Context } from '../context.js';
import { table } from '../output.js';

interface AuthStatus {
  target: string;
  auth: string;
  status: 'logged-in' | 'expired' | 'not-logged-in' | 'static' | 'none';
  expiresAt?: string;
  scope?: string;
  refreshable?: boolean;
}

type TargetAuth = Exclude<Target, StdioTarget>['auth'];

function authOf(target: Target): TargetAuth {
  return target.type === 'stdio' ? undefined : target.auth;
}

function statusOf(name: string, target: Target, record: CredentialRecord, now: number): AuthStatus {
  const auth = authOf(target);
  if (!auth) return { target: name, auth: 'none', status: 'none' };
  if (auth.type === 'oauth2') {
    const tokens = record.oauth2;
    if (!tokens) return { target: name, auth: `oauth2/${auth.flow}`, status: auth.flow === 'client_credentials' ? 'static' : 'not-logged-in' };
    return {
      target: name,
      auth: `oauth2/${auth.flow}`,
      status: isExpired(tokens, now) && !tokens.refreshToken ? 'expired' : 'logged-in',
      ...(tokens.expiresAt ? { expiresAt: new Date(tokens.expiresAt).toISOString() } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      refreshable: tokens.refreshToken !== undefined,
    };
  }
  if (auth.type === 'mcp-oauth') {
    const tokens = record.mcp?.tokens as { expires_in?: number; refresh_token?: string; scope?: string } | undefined;
    if (!tokens) return { target: name, auth: 'mcp-oauth', status: 'not-logged-in' };
    const expiresAt = tokens.expires_in && record.mcp?.obtainedAt ? record.mcp.obtainedAt + tokens.expires_in * 1000 : undefined;
    return {
      target: name,
      auth: 'mcp-oauth',
      status: expiresAt !== undefined && expiresAt <= now && !tokens.refresh_token ? 'expired' : 'logged-in',
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      refreshable: tokens.refresh_token !== undefined,
    };
  }
  return { target: name, auth: auth.type, status: 'static' };
}

interface LoginFlags {
  flow?: string;
  browser?: boolean;
  timeout?: string;
}

async function login(context: Context, name: string, flags: LoginFlags): Promise<void> {
  const target = getTarget(await context.loadConfig(), name);
  const store = new CredentialStore(context.paths.credentialsDir);
  const timeoutSeconds = flags.timeout === undefined ? 300 : Number(flags.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new CliError('USAGE', `Invalid --timeout "${flags.timeout}"`);
  const deps = {
    log: (line: string) => context.printer.info(line),
    openUrl: flags.browser === false ? async () => false : context.runtime.openUrl,
    timeoutMs: timeoutSeconds * 1000,
    fetchImpl: context.runtime.fetchImpl,
  };
  const auth = authOf(target);
  if ((target.type === 'http' || target.type === 'sse') && auth?.type === 'mcp-oauth') {
    const result = await loginMcp({ name, target, config: auth, store, deps });
    const text = result.alreadyAuthorized
      ? `Already logged in to "${name}" (${result.toolCount} tools available)`
      : `Logged in to "${name}" (${result.toolCount} tools available)`;
    context.printer.result({ target: name, ...result }, text);
    return;
  }
  if (auth?.type === 'oauth2') {
    if (flags.flow !== undefined && !(OAUTH2_FLOWS as readonly string[]).includes(flags.flow)) {
      throw new CliError('USAGE', `Invalid --flow "${flags.flow}"`);
    }
    const tokens = await loginOAuth2({ name, config: auth, store, deps, flow: flags.flow as OAuth2Config['flow'] | undefined });
    const expires = tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'no expiry given';
    context.printer.result(
      { target: name, expiresAt: tokens.expiresAt, scope: tokens.scope, refreshable: tokens.refreshToken !== undefined },
      `Logged in to "${name}" (token expires ${expires}${tokens.refreshToken ? ', auto-refresh enabled' : ''})`,
    );
    return;
  }
  throw new CliError('USAGE', `Target "${name}" is not configured for OAuth`, {
    hint: `Re-add it with --oauth (and --client-id for OpenAPI targets), e.g. \`anycli add ... --force --oauth\``,
  });
}

export function registerAuthCommands(program: Command, ctx: () => Context): void {
  const auth = program.command('auth').description('Manage OAuth logins and stored credentials');

  auth
    .command('login')
    .description('Log in to a target in the browser (OAuth2 / MCP authorization) and store the tokens')
    .argument('<target>')
    .option('--flow <flow>', `override the OAuth2 grant: ${OAUTH2_FLOWS.join(' | ')}`)
    .option('--no-browser', 'do not open a browser; print the URL instead')
    .option('--timeout <seconds>', 'how long to wait for the browser redirect', '300')
    .action(async (name: string, flags: LoginFlags) => login(ctx(), name, flags));

  auth
    .command('status')
    .description('Show login state of targets (tokens are never printed)')
    .argument('[target]')
    .action(async (name: string | undefined) => {
      const context = ctx();
      const config = await context.loadConfig();
      const store = new CredentialStore(context.paths.credentialsDir);
      const names = name ? [name] : Object.keys(config.targets);
      const statuses = await Promise.all(
        names.map(async (item) => statusOf(item, getTarget(config, item), await store.read(item), Date.now())),
      );
      const rows = statuses.map((status) => [status.target, status.auth, status.status, status.expiresAt ?? '', status.scope ?? '']);
      context.printer.result(statuses, rows.length > 0 ? table([['TARGET', 'AUTH', 'STATUS', 'EXPIRES', 'SCOPE'], ...rows]) : 'No targets');
    });

  auth
    .command('logout')
    .description('Delete the stored credentials of a target')
    .argument('<target>')
    .action(async (name: string) => {
      const context = ctx();
      getTarget(await context.loadConfig(), name);
      await new CredentialStore(context.paths.credentialsDir).remove(name);
      context.printer.result({ loggedOut: name }, `Removed stored credentials for "${name}"`);
    });
}
