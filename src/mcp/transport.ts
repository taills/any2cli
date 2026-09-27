import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpTarget } from '../config/schema.js';
import { interpolateDeep } from '../core/interpolate.js';

export interface TransportOptions {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  authProvider?: OAuthClientProvider;
}

function withQuery(url: string, query: Record<string, string> | undefined): URL {
  const parsed = new URL(url);
  Object.entries(query ?? {}).forEach(([key, value]) => parsed.searchParams.set(key, value));
  return parsed;
}

export function createTransport(target: McpTarget, options: TransportOptions = {}): Transport {
  if (target.type === 'stdio') {
    return new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: { ...getDefaultEnvironment(), ...interpolateDeep(target.env) },
      cwd: target.cwd,
      stderr: 'pipe',
    });
  }
  const headers = { ...interpolateDeep(target.headers), ...options.headers };
  const url = withQuery(target.url, options.query);
  if (target.type === 'sse') {
    return new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }),
      },
      authProvider: options.authProvider,
    });
  }
  return new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider: options.authProvider });
}
