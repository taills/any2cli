import type { Writable } from 'node:stream';
import pkg from '../../package.json' with { type: 'json' };
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DEFAULT_TIMEOUT_MS, type McpTarget } from '../config/schema.js';
import { CliError, findCliErrorInChain } from '../core/errors.js';
import { findByName, suggestNames } from '../core/names.js';
import type { CallOptions, CallOutcome, TargetAdapter, ToolDescriptor } from '../core/types.js';
import { formatMcpResult, type McpCallResult } from './format.js';
import { createTransport } from './transport.js';

export { formatMcpResult } from './format.js';

export const CLIENT_INFO = { name: 'any2cli', version: pkg.version };

export interface McpAdapterOptions {
  name: string;
  target: McpTarget;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  authProvider?: OAuthClientProvider;
  timeoutMs?: number;
  /** When set, the server's stderr is forwarded here live (e.g. --verbose). */
  stderr?: Writable;
  /** Paths --save must never write to (any2cli's own config and credentials). */
  protectedDirs?: readonly string[];
}

const STDERR_TAIL_LINES = 20;

function captureStderr(transport: Transport, forward: Writable | undefined): () => string {
  const lines: string[] = [];
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on('data', (chunk: Buffer) => {
      forward?.write(chunk);
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      lines.splice(0, Math.max(0, lines.length - STDERR_TAIL_LINES));
    });
  }
  return () => lines.join('\n');
}

function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'number') return code;
  const match = /\b(401|403)\b/.exec(String((error as Error | undefined)?.message ?? ''));
  return match ? Number(match[1]) : undefined;
}

export function mapConnectError(error: unknown, name: string, stderrTail: string): CliError {
  const nested = findCliErrorInChain(error);
  if (nested) return nested;
  const loginHint = `Run \`any2cli auth login ${name}\`, or configure headers/auth for the target`;
  if (error instanceof UnauthorizedError || httpStatusOf(error) === 401) {
    return new CliError('AUTH_REQUIRED', `Target "${name}" requires authentication`, { hint: loginHint, cause: error });
  }
  if (httpStatusOf(error) === 403) {
    return new CliError('AUTH_FAILED', `Target "${name}" rejected the credentials (403)`, { hint: loginHint, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError('CONNECTION', `Cannot connect to MCP target "${name}": ${message}`, {
    hint: `Check the target with \`any2cli doctor ${name}\``,
    details: stderrTail ? { stderr: stderrTail } : undefined,
    cause: error,
  });
}

class McpAdapter implements TargetAdapter {
  private tools?: ToolDescriptor[];

  constructor(
    private readonly name: string,
    private readonly client: Client,
    private readonly timeoutMs: number,
    private readonly protectedDirs: readonly string[] = [],
  ) {}

  async listTools(): Promise<ToolDescriptor[]> {
    if (this.tools) return this.tools;
    const collected: ToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {}, { timeout: this.timeoutMs });
      collected.push(
        ...page.tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title,
          description: tool.description,
          inputSchema: tool.inputSchema as ToolDescriptor['inputSchema'],
        })),
      );
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = collected;
    return collected;
  }

  async getTool(name: string): Promise<ToolDescriptor> {
    const tools = await this.listTools();
    const tool = findByName(tools, name);
    if (tool) return tool;
    const similar = suggestNames(tools, name);
    throw new CliError('NOT_FOUND', `Tool "${name}" not found on target "${this.name}"`, {
      hint: similar.length > 0 ? `Did you mean: ${similar.join(', ')}?` : `Run \`any2cli tools ${this.name}\` to list tools`,
    });
  }

  async callTool(tool: ToolDescriptor, args: Record<string, unknown>, options: CallOptions): Promise<CallOutcome> {
    if (options.dryRun) return { ok: true, output: { dryRun: true, target: this.name, tool: tool.name, arguments: args } };
    const timeout = options.timeoutMs ?? this.timeoutMs;
    let result: McpCallResult;
    try {
      result = (await this.client.callTool({ name: tool.name, arguments: args }, undefined, { timeout })) as McpCallResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /timed? ?out/i.test(message) ? 'TIMEOUT' : 'REMOTE_ERROR';
      throw new CliError(code, `Tool "${tool.name}" failed: ${message}`, { cause: error });
    }
    return formatMcpResult(result, options, this.protectedDirs);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

export async function openMcpAdapter(options: McpAdapterOptions): Promise<TargetAdapter> {
  const timeoutMs = options.timeoutMs ?? options.target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = createTransport(options.target, {
    headers: options.headers,
    query: options.query,
    authProvider: options.authProvider,
  });
  const stderrTail = captureStderr(transport, options.stderr);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw mapConnectError(error, options.name, stderrTail());
  }
  return new McpAdapter(options.name, client, timeoutMs, options.protectedDirs);
}
