import type { Command } from 'commander';
import { getTarget } from '../../config/store.js';
import { buildToolArgs, parseToolTokens, readAllStdin, splitGlobalFlags, type TrailingGlobal } from '../../core/args.js';
import { CliError } from '../../core/errors.js';
import { firstLine, renderSignature, renderToolHelp } from '../../core/schema-sig.js';
import type { TargetAdapter, ToolDescriptor } from '../../core/types.js';
import { openTarget } from '../../targets/open.js';
import type { Context, GlobalOptions } from '../context.js';

export async function withAdapter<T>(context: Context, name: string, fn: (adapter: TargetAdapter) => Promise<T>): Promise<T> {
  const target = getTarget(await context.loadConfig(), name);
  const adapter = await openTarget(name, target, {
    paths: context.paths,
    serverStderr: context.globals.verbose ? context.runtime.io.stderr : undefined,
    fetchImpl: context.runtime.fetchImpl,
  });
  try {
    return await fn(adapter);
  } finally {
    await adapter.close();
  }
}

function matchesFilter(tool: ToolDescriptor, filter: string | undefined): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return [tool.name, tool.title ?? '', tool.description ?? ''].some((text) => text.toLowerCase().includes(needle));
}

function renderToolList(name: string, type: string, tools: ToolDescriptor[], total: number): string {
  const header = [
    `${name} (${type}) — ${tools.length === total ? total : `${tools.length} of ${total}`} tools`,
    `Call: any2cli call ${name} <tool> --param value   Details: any2cli describe ${name} <tool>`,
    '',
  ];
  const body = tools.flatMap((tool) => {
    const signature = renderSignature(tool).slice(tool.name.length).trim();
    const summary = firstLine(tool.description) || tool.title || '';
    return [summary ? `${tool.name}: ${summary}` : tool.name, ...(signature ? [`  ${signature}`] : [])];
  });
  return [...header, ...body].join('\n');
}

function setGlobals(program: Command, keys: readonly TrailingGlobal[], value: (key: TrailingGlobal) => boolean | undefined): void {
  keys.forEach((key) => program.setOptionValue(key, value(key)));
}

export function registerToolCommands(program: Command, ctx: () => Context): void {
  program
    .command('tools')
    .description('List the tools (MCP) or operations (OpenAPI) of a target')
    .argument('<target>')
    .option('--filter <text>', 'only show tools whose name or description contains text')
    .option('--names', 'print tool names only')
    .action(async (name: string, flags: { filter?: string; names?: boolean }) => {
      const context = ctx();
      const target = getTarget(await context.loadConfig(), name);
      await withAdapter(context, name, async (adapter) => {
        const all = await adapter.listTools();
        const tools = all.filter((tool) => matchesFilter(tool, flags.filter));
        if (flags.names) {
          context.printer.result(tools.map((tool) => tool.name), tools.map((tool) => tool.name).join('\n'));
          return;
        }
        context.printer.result(tools, renderToolList(name, target.type, tools, all.length));
      });
    });

  program
    .command('describe')
    .description('Show the full parameter documentation of one tool')
    .argument('<target>')
    .argument('<tool>')
    .action(async (name: string, toolName: string) => {
      const context = ctx();
      await withAdapter(context, name, async (adapter) => {
        const tool = await adapter.getTool(toolName);
        context.printer.result(tool, renderToolHelp(tool, `any2cli call ${name}`));
      });
    });

  program
    .command('call')
    .description('Call a tool: any2cli call <target> <tool> --param value ... (shorthand: any2cli <target> <tool> ...)')
    .argument('<target>')
    .argument('<tool>')
    .argument('[params...]', "tool parameters as --name value, or --args '<json>'")
    .passThroughOptions()
    .allowUnknownOption()
    .addHelpText(
      'after',
      `
Parameters are matched to the tool's input schema (case/dash-insensitive) and converted to its types.
Repeat a flag for arrays; pass objects as JSON. Reserved options:
  --args '<json>'        whole argument object (flags override its keys)
  --args-file <path|->   read the argument object from a file or stdin
  --raw                  print the unprocessed MCP result / HTTP status+headers+body
  --dry-run              show what would be sent without calling
  --call-timeout <ms>    per-call timeout
  --save <file>          write binary output (images, downloads) to a file
  --help                 show this tool's parameters

Exit codes: 0 ok, 2 usage, 3 login required, 4 tool/API error, 5 connection, 6 config`,
    )
    .action(async (name: string, toolName: string, params: string[]) => {
      const parsed = parseToolTokens(params);
      const before = program.opts<GlobalOptions>();
      // Until the tool schema is known, treat trailing --json etc. as any2cli's (so early errors honor them).
      const tentative = splitGlobalFlags(parsed.pairs).globals;
      setGlobals(program, tentative, () => true);
      await withAdapter(ctx(), name, async (adapter) => {
        const tool = await adapter.getTool(toolName);
        const { pairs, globals } = splitGlobalFlags(parsed.pairs, tool.inputSchema);
        setGlobals(program, tentative.filter((key) => !globals.includes(key)), (key) => before[key]);
        const context = ctx();
        if (parsed.reserved.help) {
          context.printer.data(renderToolHelp(tool, `any2cli call ${name}`));
          return;
        }
        const readStdin = context.runtime.readStdin ?? readAllStdin;
        const args = await buildToolArgs({ pairs, reserved: parsed.reserved, schema: tool.inputSchema, readStdin });
        const { raw, dryRun, timeoutMs, save } = parsed.reserved;
        const outcome = await adapter.callTool(tool, args, { raw, dryRun, timeoutMs, save });
        context.printer.data(context.printer.json && typeof outcome.output === 'string' ? JSON.stringify(outcome.output) : outcome.output);
        if (!outcome.ok) {
          const status = outcome.details?.status;
          throw new CliError('REMOTE_ERROR', status ? `HTTP ${status} from ${tool.name}` : `Tool "${tool.name}" reported an error`, {
            hint: outcome.details?.hint as string | undefined,
            details: status ? { status } : undefined,
          });
        }
      });
    });
}
