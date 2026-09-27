import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface MockApi {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type MockHandler = (req: RecordedRequest) => { status?: number; headers?: Record<string, string>; body?: string | Buffer } | undefined;

/** Records every request and echoes it back as JSON unless a custom handler answers. */
export async function startMockApi(handler?: MockHandler): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(recorded);
    const custom = handler?.(recorded);
    if (custom) {
      res.writeHead(custom.status ?? 200, custom.headers ?? { 'content-type': 'application/json' });
      res.end(custom.body ?? '');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: recorded.method, path: recorded.path, query: recorded.query }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
