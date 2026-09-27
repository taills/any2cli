import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createFixtureServer } from './mcp-server.js';

export interface RunningHttpServer {
  url: string;
  requests: Array<{ path: string; authorization?: string }>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export interface HttpMcpServerOptions {
  bearer?: string;
  /** Protect the server per the MCP authorization spec, trusting tokens issued by this server. */
  oauth?: { authServerUrl: string; isValid: (token: string) => boolean };
}

/**
 * Serves the fixture MCP server over Streamable HTTP (`/mcp`, stateless) and legacy SSE
 * (`/sse` + `/messages`). When `bearer` is set every request must carry that token; with
 * `oauth` it behaves like a spec-compliant protected resource.
 */
export async function startHttpMcpServer(options: HttpMcpServerOptions = {}): Promise<RunningHttpServer> {
  const requests: RunningHttpServer['requests'] = [];
  const sseSessions = new Map<string, SSEServerTransport>();
  let baseUrl = '';

  const isAllowed = (req: IncomingMessage): boolean => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (options.oauth) return token !== undefined && options.oauth.isValid(token);
    return options.bearer === undefined || token === options.bearer;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ path: url.pathname, authorization: req.headers.authorization });
    if (options.oauth && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ resource: `${baseUrl}/mcp`, authorization_servers: [options.oauth.authServerUrl] }),
      );
      return;
    }
    if (!isAllowed(req)) {
      const challenge = options.oauth ? { 'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"` } : {};
      res.writeHead(401, { 'content-type': 'application/json', ...challenge }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/mcp') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createFixtureServer();
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
      return;
    }
    if (url.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      sseSessions.set(transport.sessionId, transport);
      res.on('close', () => sseSessions.delete(transport.sessionId));
      await createFixtureServer().connect(transport);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        res.writeHead(404).end('unknown session');
        return;
      }
      await transport.handlePostMessage(req, res, await readBody(req));
      return;
    }
    res.writeHead(404).end();
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    url: baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
