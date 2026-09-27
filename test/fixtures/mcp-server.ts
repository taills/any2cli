import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** A small but realistic MCP server used by the integration and E2E tests. */
export function createFixtureServer(): McpServer {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });

  server.registerTool(
    'echo',
    { description: 'Echo the given text back', inputSchema: { text: z.string().describe('Text to echo') } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  server.registerTool(
    'add_numbers',
    {
      title: 'Add numbers',
      description: 'Add two numbers',
      inputSchema: { a: z.number(), b: z.number() },
      outputSchema: { sum: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } }),
  );

  server.registerTool('fail', { description: 'Always fails' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'something went wrong' }],
  }));

  server.registerTool('pixel', { description: 'Returns an image' }, async () => ({
    content: [
      { type: 'text', text: 'here is a pixel' },
      { type: 'image', data: Buffer.from('fakepng').toString('base64'), mimeType: 'image/png' },
    ],
  }));

  return server;
}
