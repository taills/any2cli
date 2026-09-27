import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFixtureServer } from './mcp-server.js';

process.stderr.write('fixture server starting\n');
await createFixtureServer().connect(new StdioServerTransport());
