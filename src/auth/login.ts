import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpOAuthConfig, OAuth2Config, RemoteMcpTarget } from '../config/schema.js';
import { CliError } from '../core/errors.js';
import { interpolateDeep } from '../core/interpolate.js';
import { CLIENT_INFO, mapConnectError, openMcpAdapter } from '../mcp/adapter.js';
import { createTransport } from '../mcp/transport.js';
import { startCallbackServer, type CallbackServer } from './callback-server.js';
import { FileMcpOAuthProvider } from './mcp-provider.js';
import {
  authorizationCodeFlow,
  clientCredentialsFlow,
  deviceCodeFlow,
  resolveEndpoints,
  type FlowDeps,
} from './oauth2.js';
import type { CredentialStore, TokenSet } from './token-store.js';

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface OAuth2LoginInput {
  name: string;
  config: OAuth2Config;
  store: CredentialStore;
  deps: FlowDeps;
  flow?: OAuth2Config['flow'];
}

/** Runs the configured OAuth2 grant and stores the resulting tokens. */
export async function loginOAuth2(input: OAuth2LoginInput): Promise<TokenSet> {
  const config = interpolateDeep(input.config);
  const endpoints = await resolveEndpoints(config, input.deps.fetchImpl);
  const flow = input.flow ?? config.flow;
  const tokens =
    flow === 'device_code'
      ? await deviceCodeFlow(config, endpoints, input.deps)
      : flow === 'client_credentials'
        ? await clientCredentialsFlow(config, endpoints, input.deps)
        : await authorizationCodeFlow(config, endpoints, input.deps);
  await input.store.update(input.name, (record) => ({ ...record, oauth2: tokens }));
  return tokens;
}

export interface McpLoginInput {
  name: string;
  target: RemoteMcpTarget;
  config: McpOAuthConfig;
  store: CredentialStore;
  deps: Pick<FlowDeps, 'log' | 'openUrl' | 'timeoutMs'>;
  headers?: Record<string, string>;
}

export interface McpLoginResult {
  alreadyAuthorized: boolean;
  toolCount: number;
}

async function startServerFor(config: McpOAuthConfig, storedRedirect: string | undefined): Promise<CallbackServer> {
  const host = config.redirectHost;
  if (config.redirectPort !== undefined) return startCallbackServer({ port: config.redirectPort, host });
  const storedPort = storedRedirect ? Number(new URL(storedRedirect).port) : 0;
  try {
    return await startCallbackServer({ port: storedPort, host });
  } catch {
    return startCallbackServer({ port: 0, host });
  }
}

function isUnauthorized(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof UnauthorizedError) return true;
    current = (current as Error).cause;
  }
  return false;
}

/**
 * Logs in to a remote MCP server using the MCP authorization spec. The SDK discovers the
 * authorization server, registers the client dynamically when needed and runs PKCE; we supply
 * the loopback redirect and the browser.
 */
export async function loginMcp(input: McpLoginInput): Promise<McpLoginResult> {
  const record = await input.store.read(input.name);
  const server = await startServerFor(input.config, record.mcp?.redirectUri);
  try {
    const provider = await FileMcpOAuthProvider.create({
      name: input.name,
      config: input.config,
      store: input.store,
      interactive: true,
      redirectUrl: server.redirectUri,
      onAuthorizationUrl: async (url) => {
        const opened = await input.deps.openUrl(url.toString()).catch(() => false);
        input.deps.log(opened ? 'Opened your browser to authorize any2cli. If nothing happened, open this URL:' : 'Open this URL in a browser to authorize any2cli:');
        input.deps.log(`  ${url.toString()}`);
      },
    });
    await provider.forgetClientIfRedirectChanged(server.redirectUri);

    const transport = createTransport(input.target, { authProvider: provider, headers: input.headers });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return { alreadyAuthorized: true, toolCount: tools.length };
    } catch (error) {
      if (!isUnauthorized(error)) throw mapConnectError(error, input.name, '');
    } finally {
      await client.close().catch(() => undefined);
    }

    const code = await server.waitForCode(provider.lastState, input.deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    await (transport as StreamableHTTPClientTransport | SSEClientTransport).finishAuth(code).catch((error: unknown) => {
      throw new CliError('AUTH_FAILED', `Token exchange failed: ${(error as Error).message}`, { cause: error });
    });

    const verifyProvider = await FileMcpOAuthProvider.create({ name: input.name, config: input.config, store: input.store, interactive: false });
    const adapter = await openMcpAdapter({ name: input.name, target: input.target, authProvider: verifyProvider, headers: input.headers });
    try {
      return { alreadyAuthorized: false, toolCount: (await adapter.listTools()).length };
    } finally {
      await adapter.close();
    }
  } finally {
    await server.close();
  }
}
