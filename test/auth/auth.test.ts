import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCallbackServer } from '../../src/auth/callback-server.js';
import { loginOAuth2 } from '../../src/auth/login.js';
import { assertSecureEndpoint, authorizationCodeFlow, deviceCodeFlow, resolveEndpoints } from '../../src/auth/oauth2.js';
import { createPkce, randomState } from '../../src/auth/pkce.js';
import { resolveAuthMaterial } from '../../src/auth/resolve.js';
import { CredentialStore } from '../../src/auth/token-store.js';
import { parseTarget, type OAuth2Config, type OpenApiTarget } from '../../src/config/schema.js';
import { fakeBrowser, startMockOAuthServer, type MockOAuthServer } from '../fixtures/oauth-server.js';

const silent = { log: () => undefined };

function oauth2(overrides: Record<string, unknown>): OAuth2Config {
  const target = parseTarget({ type: 'openapi', spec: 'x', auth: { type: 'oauth2', clientId: 'cli', ...overrides } });
  return (target as OpenApiTarget).auth as OAuth2Config;
}

describe('pkce', () => {
  it('creates an S256 challenge for a high-entropy verifier', () => {
    const { verifier, challenge, method } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(method).toBe('S256');
    expect(randomState()).not.toBe(randomState());
  });
});

describe('callback server', () => {
  it('binds to loopback and returns the code when the state matches', async () => {
    const server = await startCallbackServer({});
    try {
      expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const response = await fetch(`${server.redirectUri}?code=abc&state=s1`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('You can close this window');
      await expect(server.waitForCode('s1', 1000)).resolves.toBe('abc');
    } finally {
      await server.close();
    }
  });

  it('rejects a state mismatch (CSRF protection)', async () => {
    const server = await startCallbackServer({});
    try {
      await fetch(`${server.redirectUri}?code=abc&state=evil`);
      await expect(server.waitForCode('expected', 1000)).rejects.toMatchObject({ code: 'AUTH_FAILED', message: /state/ });
    } finally {
      await server.close();
    }
  });

  it('surfaces provider errors with escaped HTML', async () => {
    const server = await startCallbackServer({ path: '/cb' });
    try {
      const page = await (await fetch(`${server.redirectUri}?error=access_denied&error_description=%3Cscript%3E`)).text();
      expect(page).not.toContain('<script>');
      expect(page).toContain('&lt;script&gt;');
      await expect(server.waitForCode('x', 1000)).rejects.toMatchObject({ code: 'AUTH_FAILED', message: /access_denied/ });
    } finally {
      await server.close();
    }
  });

  it('ignores other paths and times out', async () => {
    const server = await startCallbackServer({});
    try {
      expect((await fetch(server.redirectUri.replace('/callback', '/other'))).status).toBe(404);
      await expect(server.waitForCode('x', 50)).rejects.toMatchObject({ code: 'AUTH_FAILED', message: /timed out/i });
    } finally {
      await server.close();
    }
  });

  it('also answers on ::1 when the redirect host is localhost', async () => {
    const server = await startCallbackServer({ host: 'localhost' });
    try {
      expect(server.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      const ipv6 = await fetch(`http://[::1]:${server.port}/callback?code=c6&state=s`).catch(() => undefined);
      const response = ipv6 ?? (await fetch(`http://127.0.0.1:${server.port}/callback?code=c6&state=s`));
      expect(response.status).toBe(200);
      await expect(server.waitForCode('s', 1000)).resolves.toBe('c6');
    } finally {
      await server.close();
    }
  });

  it('reports an occupied port as a CONFIG error', async () => {
    const first = await startCallbackServer({});
    try {
      await expect(startCallbackServer({ port: first.port })).rejects.toMatchObject({ code: 'CONFIG' });
    } finally {
      await first.close();
    }
  });
});

describe('credential store', () => {
  let store: CredentialStore;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anycli-cred-'));
    store = new CredentialStore(join(dir, 'credentials'));
  });

  it('writes owner-only files inside an owner-only directory', async () => {
    await store.update('api', (record) => ({ ...record, oauth2: { accessToken: 'a', tokenType: 'Bearer', obtainedAt: 1 } }));
    expect((await stat(join(dir, 'credentials'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'credentials', 'api.json'))).mode & 0o777).toBe(0o600);
    expect((await store.read('api')).oauth2?.accessToken).toBe('a');
  });

  it('returns an empty record for unknown targets and removes records', async () => {
    expect(await store.read('none')).toEqual({ version: 1 });
    await store.update('gone', (record) => ({ ...record, oauth2: { accessToken: 'a', tokenType: 'Bearer', obtainedAt: 1 } }));
    await store.remove('gone');
    expect(await store.read('gone')).toEqual({ version: 1 });
  });

  it('refuses unsafe names', async () => {
    await expect(store.read('../escape')).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('tightens a pre-existing credentials directory to 0700', async () => {
    await mkdir(join(dir, 'credentials'), { mode: 0o755 });
    await chmod(join(dir, 'credentials'), 0o755);
    await store.update('api', (record) => record);
    expect((await stat(join(dir, 'credentials'))).mode & 0o777).toBe(0o700);
  });

  it('serializes concurrent updates with a lock', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.update('race', (record) => ({ ...record, counter: ((record.counter as number | undefined) ?? 0) + 1, [`k${index}`]: true })),
      ),
    );
    const record = await store.read('race');
    expect(record.counter).toBe(8);
    expect((await readdir(join(dir, 'credentials'))).filter((file) => file.endsWith('.lock'))).toEqual([]);
  });
});

describe('OAuth2 flows against a mock authorization server', () => {
  let server: MockOAuthServer;
  let dir: string;
  beforeAll(async () => {
    server = await startMockOAuthServer({ clientSecret: 'shh' });
  });
  afterAll(async () => server.close());
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anycli-flow-'));
    server.deny = false;
    server.expiresIn = 3600;
  });

  const endpoints = () => ({
    authorizationUrl: `${server.url}/authorize`,
    tokenUrl: `${server.url}/token`,
    deviceAuthorizationUrl: `${server.url}/device`,
  });

  it('discovers endpoints from a discovery document', async () => {
    const resolved = await resolveEndpoints(oauth2({ discoveryUrl: `${server.url}/.well-known/openid-configuration` }));
    expect(resolved).toEqual(endpoints());
    await expect(resolveEndpoints(oauth2({}))).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('only allows https endpoints, or plain http on loopback', async () => {
    expect(() => assertSecureEndpoint('token', 'https://auth.example.com/token')).not.toThrow();
    expect(() => assertSecureEndpoint('token', 'http://127.0.0.1:8080/token')).not.toThrow();
    expect(() => assertSecureEndpoint('token', 'http://localhost/token')).not.toThrow();
    expect(() => assertSecureEndpoint('token', 'http://[::1]:9/token')).not.toThrow();
    expect(() => assertSecureEndpoint('token', 'http://auth.example.com/token')).toThrow(/must use https/);
    expect(() => assertSecureEndpoint('token', 'not a url')).toThrow(/not a valid URL/);
    await expect(resolveEndpoints(oauth2({ tokenUrl: 'http://evil.example.com/token' }))).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('runs the authorization code flow with PKCE and state', async () => {
    const config = oauth2({ clientSecret: 'shh', scopes: ['read', 'write'], audience: 'api', extraAuthParams: { prompt: 'consent' } });
    const opened: string[] = [];
    const tokens = await authorizationCodeFlow(config, endpoints(), {
      ...silent,
      openUrl: async (url) => {
        opened.push(url);
        return fakeBrowser(url);
      },
    });
    expect(tokens.accessToken).toMatch(/^at-/);
    expect(tokens.refreshToken).toMatch(/^rt-/);
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const params = server.lastAuthorizeParams as URLSearchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('read write');
    expect(params.get('audience')).toBe('api');
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('state')).toBeTruthy();
    expect(opened).toHaveLength(1);
  });

  it('prints the URL when no browser can be opened and fails cleanly when the user denies', async () => {
    server.deny = true;
    const logs: string[] = [];
    await expect(
      authorizationCodeFlow(oauth2({ clientSecret: 'shh' }), endpoints(), {
        log: (line) => logs.push(line),
        openUrl: async (url) => {
          await fakeBrowser(url);
          return false;
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', message: /access_denied/ });
    expect(logs.join('\n')).toContain(`${server.url}/authorize?`);
  });

  it('supports client_secret_basic and form-encoded token responses', async () => {
    const formServer = await startMockOAuthServer({ clientSecret: 's p', formResponses: true });
    try {
      const tokens = await authorizationCodeFlow(
        oauth2({ clientSecret: 's p', tokenAuthMethod: 'client_secret_basic' }),
        { authorizationUrl: `${formServer.url}/authorize`, tokenUrl: `${formServer.url}/token` },
        { ...silent, openUrl: fakeBrowser },
      );
      expect(tokens.accessToken).toMatch(/^at-/);
    } finally {
      await formServer.close();
    }
  });

  it('reports token endpoint errors without leaking secrets', async () => {
    const error = await authorizationCodeFlow(oauth2({ clientSecret: 'wrong-secret' }), endpoints(), {
      ...silent,
      openUrl: fakeBrowser,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTH_FAILED', message: /invalid_client/ });
    expect(JSON.stringify(error)).not.toContain('wrong-secret');
  });

  it('runs the device code flow, honouring authorization_pending and slow_down', async () => {
    server.devicePendingPolls = 2;
    const logs: string[] = [];
    const sleeps: number[] = [];
    const tokens = await deviceCodeFlow(oauth2({ clientSecret: 'shh', flow: 'device_code' }), endpoints(), {
      log: (line) => logs.push(line),
      openUrl: async () => false,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(tokens.accessToken).toMatch(/^at-/);
    expect(logs.join('\n')).toContain('WDJB-MJHT');
    expect(sleeps).toEqual([5000, 5000, 10000]);
    server.devicePendingPolls = 1;
  });

  it('logs in and stores tokens, then refreshes them automatically when expired', async () => {
    const store = new CredentialStore(join(dir, 'credentials'));
    const config = oauth2({ clientSecret: 'shh', authorizationUrl: `${server.url}/authorize`, tokenUrl: `${server.url}/token` });
    server.expiresIn = 1;
    const first = await loginOAuth2({ name: 'api', config, store, deps: { ...silent, openUrl: fakeBrowser } });
    expect((await store.read('api')).oauth2?.accessToken).toBe(first.accessToken);

    server.expiresIn = 3600;
    const material = await resolveAuthMaterial('api', config, { store });
    expect(material.headers.Authorization).toMatch(/^Bearer at-/);
    expect(material.headers.Authorization).not.toBe(`Bearer ${first.accessToken}`);
    expect(server.grants.at(-1)).toBe('refresh_token');

    const again = await resolveAuthMaterial('api', config, { store });
    expect(again).toEqual(material);

    const forced = await resolveAuthMaterial('api', config, { store }, true);
    expect(forced.headers.Authorization).not.toBe(material.headers.Authorization);
  });

  it('fetches client_credentials tokens without any login', async () => {
    const store = new CredentialStore(join(dir, 'credentials'));
    const config = oauth2({ flow: 'client_credentials', clientSecret: 'shh', tokenUrl: `${server.url}/token`, scopes: ['svc'] });
    const material = await resolveAuthMaterial('svc', config, { store });
    expect(material.headers.Authorization).toMatch(/^Bearer at-/);
    expect(server.grants.at(-1)).toBe('client_credentials');
  });

  it('asks the user to log in when no token is stored', async () => {
    const store = new CredentialStore(join(dir, 'credentials'));
    const config = oauth2({ tokenUrl: `${server.url}/token` });
    await expect(resolveAuthMaterial('nobody', config, { store })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      hint: expect.stringContaining('anycli auth login nobody'),
    });
  });
});

describe('static credentials', () => {
  const store = new CredentialStore('/nonexistent');
  const env = { TOKEN: 'tkn', PASS: 'p:w' };

  it('builds bearer, basic and api key material from env references', async () => {
    expect(await resolveAuthMaterial('x', { type: 'bearer', token: '${TOKEN}' }, { store, env })).toEqual({
      headers: { Authorization: 'Bearer tkn' },
      query: {},
    });
    expect((await resolveAuthMaterial('x', { type: 'basic', username: 'u', password: '${PASS}' }, { store, env })).headers).toEqual({
      Authorization: `Basic ${Buffer.from('u:p:w').toString('base64')}`,
    });
    expect(await resolveAuthMaterial('x', { type: 'apiKey', in: 'query', name: 'key', value: '${TOKEN}' }, { store, env })).toEqual({
      headers: {},
      query: { key: 'tkn' },
    });
    expect((await resolveAuthMaterial('x', { type: 'apiKey', in: 'cookie', name: 'sid', value: 'v' }, { store, env })).headers).toEqual({
      Cookie: 'sid=v',
    });
    expect(await resolveAuthMaterial('x', undefined, { store, env })).toEqual({ headers: {}, query: {} });
  });
});
