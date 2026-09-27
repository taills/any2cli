import { Command, CommanderError } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { loadConfig } from '../config/store.js';
import { ExitCode, toCliError } from '../core/errors.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerTargetCommands } from './commands/targets.js';
import { registerToolCommands } from './commands/tools.js';
import { registerUtilityCommands } from './commands/utility.js';
import { createContext, defaultRuntime, type GlobalOptions, type Runtime } from './context.js';
import { Printer } from './output.js';

export const VERSION: string = pkg.version;

export function buildProgram(runtime: Runtime): Command {
  const program = new Command('any2cli')
    .description('Turn MCP servers and OpenAPI specs into CLI tools for LLM agents')
    .version(VERSION, '-V, --version')
    .option('-c, --config <path>', 'config file (default: ./.any2cli.json, else ~/.config/any2cli/config.json)')
    .option('--json', 'machine-readable JSON output (also for errors)')
    .option('--pretty', 'indent JSON output')
    .option('-v, --verbose', 'forward MCP server stderr and show stack traces')
    .enablePositionalOptions()
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => runtime.io.stdout.write(text),
      writeErr: (text) => runtime.io.stderr.write(text),
    })
    .addHelpText(
      'after',
      `
Quick start:
  any2cli add mcp fs -- npx -y @modelcontextprotocol/server-filesystem ~/src
  any2cli add openapi pets https://petstore3.swagger.io/api/v3/openapi.json
  any2cli tools fs
  any2cli call fs read_file --path ~/src/README.md     (or: any2cli fs read_file --path ...)
  any2cli auth login <target>                          (OAuth targets)
  any2cli gen skill -o .claude/skills                  (teach your agent)`,
    );

  const ctx = () => createContext(runtime, program.opts<GlobalOptions>());
  registerTargetCommands(program, ctx);
  registerToolCommands(program, ctx);
  registerAuthCommands(program, ctx);
  registerUtilityCommands(program, ctx);
  return program;
}

const OPTIONS_WITH_VALUE = new Set(['-c', '--config']);

/** Rewrites `any2cli <target> <tool> ...` into `any2cli call <target> <tool> ...`. */
async function expandShorthand(argv: string[], program: Command, runtime: Runtime): Promise<string[]> {
  let index = 0;
  let configOverride: string | undefined;
  while (index < argv.length && (argv[index] as string).startsWith('-')) {
    const token = argv[index] as string;
    if (OPTIONS_WITH_VALUE.has(token)) configOverride = argv[index + 1];
    else if (token.startsWith('--config=')) configOverride = token.slice('--config='.length);
    index += OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
  }
  const candidate = argv[index];
  if (candidate === undefined) return argv;
  const known = new Set(['help', ...program.commands.flatMap((command) => [command.name(), ...command.aliases()])]);
  if (known.has(candidate)) return argv;
  try {
    const { paths } = createContext(runtime, { config: configOverride });
    const config = await loadConfig(paths.configFile);
    if (config.targets[candidate]) return [...argv.slice(0, index), 'call', ...argv.slice(index)];
  } catch {
    // Fall through: commander reports the unknown command.
  }
  return argv;
}

async function hintTargets(runtime: Runtime): Promise<void> {
  try {
    const { paths } = createContext(runtime, {});
    const names = Object.keys((await loadConfig(paths.configFile)).targets);
    runtime.io.stderr.write(
      names.length > 0 ? `hint: configured targets: ${names.join(', ')} (run \`any2cli <target> <tool> ...\`)\n` : 'hint: no targets configured yet; see `any2cli add --help`\n',
    );
  } catch {
    // The config itself is broken; commander's message is enough.
  }
}

/** Runs the CLI and returns the process exit code. */
export async function run(argv: string[], runtime: Runtime = defaultRuntime()): Promise<number> {
  const program = buildProgram(runtime);
  if (argv.length === 0) {
    program.outputHelp();
    return ExitCode.OK;
  }
  try {
    await program.parseAsync(await expandShorthand(argv, program, runtime), { from: 'user' });
    return ExitCode.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.unknownCommand') await hintTargets(runtime);
      return error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    const globals = program.opts<GlobalOptions>();
    const printer = new Printer(runtime.io, { json: globals.json === true, pretty: globals.pretty === true });
    const cliError = toCliError(error);
    printer.error(cliError);
    if (globals.verbose && error instanceof Error && error.stack) runtime.io.stderr.write(`${error.stack}\n`);
    return cliError.exitCode;
  }
}
