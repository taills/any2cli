import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginMcp } from '../../src/auth/login.js';
import { CredentialStore } from '../../src/auth/token-store.js';
import { resolvePaths, type Paths } from '../../src/config/paths.js';
import { parseTarget, type McpOAuthConfig, type RemoteMcpTarget } from '../../src/config/schema.js';
import { openTarget } from '../../src/targets/open.js';
import { startHttpMcpServer, type RunningHttpServer } from '../fixtures/http-server.js';
import { fakeBrowser, startMockOAuthServer, type MockOAuthServer } from '../fixtures/oauth-server.js';

describe('MCP authorization spec login (discovery + DCR + PKCE)', () => {
  let oauth: MockOAuthServer;
  let mcp: RunningHttpServer;
  let paths: Paths;
  let store: CredentialStore;
  let target: RemoteMcpTarget;
  const silent = { log: () => undefined, openUrl: fakeBrowser, timeoutMs: 10_000 };

  beforeAll(async () => {
    oauth = await startMockOAuthServer();
    mcp = await startHttpMcpServer({ oauth: { authServerUrl: oauth.url, isValid: (token) => oauth.validTokens.has(token) } });
  });
  afterAll(async () => {
    await mcp.close();
    await oauth.close();
  });
  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), 'any2cliauth-'));
    paths = resolvePaths({ env: { ANY2CLI_HOME: home }, cwd: home, exists: () => false });
    store = new CredentialStore(paths.credentialsDir);
    target = parseTarget({ type: 'http', url: `${mcp.url}/mcp`, auth: { type: 'mcp-oauth', scopes: ['mcp'] } }) as RemoteMcpTarget;
  });

  it('refuses to open a browser during normal calls', async () => {
    await expect(openTarget('remote', target, { paths })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      hint: expect.stringContaining('any2cli auth login remote'),
    });
  });

  it('logs in through the browser, then calls tools with the stored token', async () => {
    const clientsBefore = oauth.registeredClients.length;
    const result = await loginMcp({ name: 'remote', target, config: target.auth as McpOAuthConfig, store, deps: silent });
    expect(result).toEqual({ alreadyAuthorized: false, toolCount: 4 });
    expect(oauth.registeredClients.length).toBe(clientsBefore + 1);
    expect(oauth.registeredClients.at(-1)).toMatchObject({ client_name: 'any2cli', token_endpoint_auth_method: 'none' });
    expect(oauth.lastAuthorizeParams?.get('code_challenge_method')).toBe('S256');

    const record = await store.read('remote');
    expect(record.mcp?.tokens).toMatchObject({ access_token: expect.stringMatching(/^at-/) });
    expect(record.mcp?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const adapter = await openTarget('remote', target, { paths });
    try {
      const echo = await adapter.callTool(await adapter.getTool('echo'), { text: 'authorized' }, { raw: false, dryRun: false });
      expect(echo.output).toBe('authorized');
    } finally {
      await adapter.close();
    }

    const again = await loginMcp({ name: 'remote', target, config: target.auth as McpOAuthConfig, store, deps: silent });
    expect(again).toEqual({ alreadyAuthorized: true, toolCount: 4 });
    expect(oauth.registeredClients.length).toBe(clientsBefore + 1);
  });

  it('refreshes an expired MCP token transparently', async () => {
    await loginMcp({ name: 'remote', target, config: target.auth as McpOAuthConfig, store, deps: silent });
    const before = (await store.read('remote')).mcp?.tokens?.access_token as string;
    oauth.validTokens.delete(before);

    const adapter = await openTarget('remote', target, { paths });
    try {
      expect((await adapter.listTools()).length).toBe(4);
    } finally {
      await adapter.close();
    }
    const after = (await store.read('remote')).mcp?.tokens?.access_token;
    expect(after).not.toBe(before);
    expect(oauth.grants.at(-1)).toBe('refresh_token');
  });
});
