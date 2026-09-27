import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Target } from '../../config/schema.js';
import { getTarget } from '../../config/store.js';
import { CliError, toCliError } from '../../core/errors.js';
import { assertTargetName } from '../../core/names.js';
import { renderIndexSkill, renderShim, renderTargetSkill, skillName } from '../../gen/skill.js';
import { readManifest } from '../../openapi/manifest-store.js';
import { openTarget } from '../../targets/open.js';
import type { Context } from '../context.js';
import { withAdapter } from './tools.js';

interface DoctorResult {
  target: string;
  type: string;
  ok: boolean;
  tools?: number;
  ms: number;
  error?: string;
  hint?: string;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function checkTarget(context: Context, name: string, target: Target): Promise<DoctorResult> {
  const started = Date.now();
  try {
    const adapter = await openTarget(name, target, { paths: context.paths, fetchImpl: context.runtime.fetchImpl });
    try {
      return { target: name, type: target.type, ok: true, tools: (await adapter.listTools()).length, ms: Date.now() - started };
    } finally {
      await adapter.close();
    }
  } catch (error) {
    const cli = toCliError(error);
    return { target: name, type: target.type, ok: false, ms: Date.now() - started, error: cli.message, hint: cli.hint };
  }
}

function registerDoctor(program: Command, ctx: () => Context): void {
  program
    .command('doctor')
    .description('Check that targets are reachable and authenticated')
    .argument('[targets...]', 'targets to check (default: all)')
    .action(async (names: string[]) => {
      const context = ctx();
      const config = await context.loadConfig();
      const selected = names.length > 0 ? names : Object.keys(config.targets);
      const targets = selected.map((name) => [name, getTarget(config, name)] as const);
      const results = await Promise.all(targets.map(([name, target]) => checkTarget(context, name, target)));
      const lines = [
        `config: ${context.paths.configFile}`,
        ...results.map((result) =>
          result.ok
            ? `✓ ${result.target} (${result.type}) ${result.tools} tools, ${result.ms}ms`
            : `✗ ${result.target} (${result.type}) ${result.error}${result.hint ? `\n    hint: ${result.hint}` : ''}`,
        ),
      ];
      context.printer.result({ config: context.paths.configFile, results }, lines.join('\n'));
      const failed = results.filter((result) => !result.ok).length;
      if (failed > 0) throw new CliError('CONNECTION', `${failed} of ${results.length} target(s) failed`);
    });
}

function registerGen(program: Command, ctx: () => Context): void {
  const gen = program.command('gen').description('Generate agent skills and shell shims');

  gen
    .command('skill')
    .description('Generate SKILL.md files so agents know how to use targets (no names: an index skill for anycli)')
    .argument('[targets...]')
    .option('-o, --out <dir>', 'write <dir>/<skill-name>/SKILL.md instead of printing (e.g. .claude/skills)')
    .action(async (names: string[], flags: { out?: string }) => {
      const context = ctx();
      const config = await context.loadConfig();
      const documents: Array<{ skill: string; content: string }> = [];
      if (names.length === 0) {
        const entries = Object.entries(config.targets).map(([name, target]) => ({
          name,
          type: target.type,
          description: target.description ?? (target.type === 'stdio' ? `MCP server (${target.command})` : target.type === 'openapi' ? 'REST API' : 'remote MCP server'),
        }));
        documents.push({ skill: 'anycli', content: renderIndexSkill(entries) });
      }
      for (const name of names) {
        const target = getTarget(config, name);
        const tools = await withAdapter(context, name, (adapter) => adapter.listTools());
        const title = target.type === 'openapi' ? (await readManifest(context.paths.cacheDir, name))?.title : undefined;
        documents.push({ skill: skillName(name), content: renderTargetSkill({ name, target, tools, title }) });
      }
      if (!flags.out) {
        context.printer.data(documents.map((doc) => doc.content).join('\n'));
        return;
      }
      const written: string[] = [];
      for (const doc of documents) {
        const dir = resolve(context.runtime.cwd, flags.out, doc.skill);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'SKILL.md'), doc.content);
        written.push(join(dir, 'SKILL.md'));
      }
      context.printer.result({ written }, written.map((path) => `wrote ${path}`).join('\n'));
    });

  gen
    .command('shim')
    .description('Create an executable so `<target> <tool> --param value` works as a command')
    .argument('<target>')
    .option('-d, --dir <dir>', 'directory on your PATH', join(homedir(), '.local', 'bin'))
    .option('--as <command>', 'command name (default: the target name)')
    .option('-f, --force', 'overwrite an existing file')
    .action(async (name: string, flags: { dir: string; as?: string; force?: boolean }) => {
      const context = ctx();
      getTarget(await context.loadConfig(), name);
      const command = flags.as ?? name;
      assertTargetName(command);
      const dir = resolve(context.runtime.cwd, flags.dir);
      const path = join(dir, command);
      if (!flags.force && (await exists(path))) throw new CliError('USAGE', `${path} already exists`, { hint: 'Use --force to overwrite' });
      await mkdir(dir, { recursive: true });
      await writeFile(path, renderShim(name), { mode: 0o755 });
      await chmod(path, 0o755);
      context.printer.result({ written: path }, `wrote ${path}\nUsage: ${command} <tool> --param value`);
    });
}

export function registerUtilityCommands(program: Command, ctx: () => Context): void {
  registerDoctor(program, ctx);
  registerGen(program, ctx);
}
