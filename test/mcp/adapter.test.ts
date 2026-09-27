import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTarget, type McpTarget } from '../../src/config/schema.js';
import { formatMcpResult, openMcpAdapter } from '../../src/mcp/adapter.js';
import type { TargetAdapter } from '../../src/core/types.js';
import { startHttpMcpServer, type RunningHttpServer } from '../fixtures/http-server.js';

const ROOT = resolve(import.meta.dirname, '../..');
export const STDIO_FIXTURE = {
  type: 'stdio',
  command: process.execPath,
  args: ['--import', 'tsx', join(ROOT, 'test/fixtures/stdio-server.ts')],
  cwd: ROOT,
} as const;

const OPTS = { raw: false, dryRun: false };

async function exercise(adapter: TargetAdapter): Promise<void> {
  const tools = await adapter.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual(['add_numbers', 'echo', 'fail', 'pixel']);
  const add = await adapter.getTool('add-numbers');
  expect(add.title).toBe('Add numbers');
  expect(add.inputSchema.required).toEqual(['a', 'b']);
  const sum = await adapter.callTool(add, { a: 2, b: 3 }, OPTS);
  expect(sum).toEqual({ ok: true, output: { sum: 5 } });
  const echo = await adapter.callTool(await adapter.getTool('echo'), { text: 'hi' }, OPTS);
  expect(echo).toEqual({ ok: true, output: 'hi' });
}

describe('MCP adapter over stdio', () => {
  it('lists and calls tools', async () => {
    const adapter = await openMcpAdapter({ name: 'fx', target: parseTarget(STDIO_FIXTURE) as McpTarget });
    try {
      await exercise(adapter);
      const failed = await adapter.callTool(await adapter.getTool('fail'), {}, OPTS);
      expect(failed).toEqual({ ok: false, output: 'something went wrong' });
      const raw = await adapter.callTool(await adapter.getTool('echo'), { text: 'x' }, { ...OPTS, raw: true });
      expect(raw.output).toMatchObject({ content: [{ type: 'text', text: 'x' }] });
      const dry = await adapter.callTool(await adapter.getTool('echo'), { text: 'x' }, { ...OPTS, dryRun: true });
      expect(dry.output).toEqual({ dryRun: true, target: 'fx', tool: 'echo', arguments: { text: 'x' } });
    } finally {
      await adapter.close();
    }
  });

  it('suggests similar tools when a name is unknown', async () => {
    const adapter = await openMcpAdapter({ name: 'fx', target: parseTarget(STDIO_FIXTURE) as McpTarget });
    try {
      await expect(adapter.getTool('ech')).rejects.toMatchObject({ code: 'NOT_FOUND', hint: expect.stringContaining('echo') });
    } finally {
      await adapter.close();
    }
  });

  it('reports a CONNECTION error including the server stderr when the server cannot start', async () => {
    const target = parseTarget({ type: 'stdio', command: process.execPath, args: ['-e', 'console.error("kaboom"); process.exit(3)'] });
    await expect(openMcpAdapter({ name: 'bad', target: target as McpTarget, timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'CONNECTION',
      details: { stderr: expect.stringContaining('kaboom') },
    });
  });

  it('reports a CONNECTION error when the command does not exist', async () => {
    const target = parseTarget({ type: 'stdio', command: 'anycli-definitely-missing-binary' });
    await expect(openMcpAdapter({ name: 'missing', target: target as McpTarget, timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'CONNECTION',
    });
  });
});

describe('MCP adapter over HTTP', () => {
  let server: RunningHttpServer;
  let secured: RunningHttpServer;
  beforeAll(async () => {
    server = await startHttpMcpServer();
    secured = await startHttpMcpServer({ bearer: 's3cret' });
  });
  afterAll(async () => {
    await server.close();
    await secured.close();
  });

  it('works over Streamable HTTP', async () => {
    const adapter = await openMcpAdapter({ name: 'h', target: parseTarget({ type: 'http', url: `${server.url}/mcp` }) as McpTarget });
    try {
      await exercise(adapter);
    } finally {
      await adapter.close();
    }
  });

  it('works over legacy SSE', async () => {
    const adapter = await openMcpAdapter({ name: 's', target: parseTarget({ type: 'sse', url: `${server.url}/sse` }) as McpTarget });
    try {
      await exercise(adapter);
    } finally {
      await adapter.close();
    }
  });

  it('sends extra headers and maps 401 to AUTH_REQUIRED', async () => {
    const target = parseTarget({ type: 'http', url: `${secured.url}/mcp` }) as McpTarget;
    await expect(openMcpAdapter({ name: 'sec', target })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const adapter = await openMcpAdapter({ name: 'sec', target, headers: { Authorization: 'Bearer s3cret' } });
    try {
      expect((await adapter.listTools()).length).toBe(4);
    } finally {
      await adapter.close();
    }
  });

  it('maps an unreachable server to CONNECTION', async () => {
    const target = parseTarget({ type: 'http', url: 'http://127.0.0.1:1/mcp' }) as McpTarget;
    await expect(openMcpAdapter({ name: 'down', target, timeoutMs: 3000 })).rejects.toMatchObject({ code: 'CONNECTION' });
  });
});

describe('formatMcpResult', () => {
  it('summarizes binary content instead of dumping base64', async () => {
    const result = await formatMcpResult(
      { content: [{ type: 'text', text: 'a' }, { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }] },
      OPTS,
    );
    expect(result.output).toBe('a\n\n[image image/png, 3 bytes omitted; use --save <file> or --raw]');
  });

  it('saves binary content with --save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anycli-save-'));
    const file = join(dir, 'out.png');
    const result = await formatMcpResult(
      { content: [{ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }] },
      { ...OPTS, save: file },
    );
    expect(await readFile(file, 'utf8')).toBe('png');
    expect(result.output).toBe(`[image image/png saved to ${file}]`);
  });

  it('refuses to --save into protected directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anycli-home-'));
    await expect(
      formatMcpResult(
        { content: [{ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }] },
        { ...OPTS, save: join(home, 'config.json') },
        [home],
      ),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('prints text instead of structured content that only wraps the same text', async () => {
    const wrapped = await formatMcpResult(
      { content: [{ type: 'text', text: 'line 1\nline 2' }], structuredContent: { content: 'line 1\nline 2' } },
      OPTS,
    );
    expect(wrapped.output).toBe('line 1\nline 2');
    const real = await formatMcpResult({ content: [{ type: 'text', text: '42' }], structuredContent: { sum: 42 } }, OPTS);
    expect(real.output).toEqual({ sum: 42 });
  });

  it('renders embedded resources and links', async () => {
    const result = await formatMcpResult(
      {
        content: [
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
          { type: 'resource_link', uri: 'file:///b.txt', name: 'b' },
        ],
      },
      OPTS,
    );
    expect(result.output).toBe('hello\n\n[resource link: file:///b.txt]');
  });
});
