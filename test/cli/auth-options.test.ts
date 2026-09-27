import { describe, expect, it } from 'vitest';
import { openBrowser } from '../../src/auth/browser.js';
import { buildAuth } from '../../src/cli/auth-options.js';
import { CliError } from '../../src/core/errors.js';

describe('openBrowser', () => {
  it('does nothing when disabled', async () => {
    expect(await openBrowser('http://x', { ANYCLI_NO_BROWSER: '1' })).toBe(false);
  });

  it('uses $BROWSER when set', async () => {
    expect(await openBrowser('http://x', { BROWSER: 'true' })).toBe(true);
    expect(await openBrowser('http://x', { BROWSER: 'anycli-no-such-browser' })).toBe(false);
  });
});

describe('buildAuth', () => {
  const spec = [
    { name: 'key', type: 'apiKey', in: 'query', paramName: 'api_key' },
    { name: 'oidc', type: 'openIdConnect', discoveryUrl: 'https://id.test/.well-known/openid-configuration' },
  ];

  it('returns undefined without auth flags', () => {
    expect(buildAuth({}, 'openapi')).toBeUndefined();
  });

  it('builds basic and api key auth, using the spec for defaults', () => {
    expect(buildAuth({ basic: 'u:p:w' }, 'openapi')).toEqual({ type: 'basic', username: 'u', password: 'p:w' });
    expect(() => buildAuth({ basic: 'nocolon' }, 'openapi')).toThrow(CliError);
    expect(buildAuth({ apiKey: 'k' }, 'openapi', spec)).toEqual({ type: 'apiKey', in: 'query', name: 'api_key', value: 'k' });
    expect(buildAuth({ apiKey: 'k', apiKeyIn: 'cookie', apiKeyName: 'sid' }, 'openapi')).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'sid',
      value: 'k',
    });
    expect(() => buildAuth({ apiKey: 'k', apiKeyIn: 'body' }, 'openapi')).toThrow(/api-key-in/);
  });

  it('uses MCP OAuth for remote MCP servers unless endpoints are given', () => {
    expect(buildAuth({ oauth: true, scopes: 'a, b', redirectPort: '8765' }, 'mcp')).toEqual({
      type: 'mcp-oauth',
      scopes: ['a', 'b'],
      redirectPort: 8765,
    });
    expect(buildAuth({ clientId: 'c', tokenUrl: 'https://t', flow: 'client_credentials' }, 'mcp')).toMatchObject({
      type: 'oauth2',
      flow: 'client_credentials',
    });
  });

  it('fills OAuth2 endpoints from openIdConnect discovery and validates input', () => {
    expect(buildAuth({ oauth: true, clientId: 'c' }, 'openapi', spec)).toMatchObject({
      type: 'oauth2',
      flow: 'authorization_code',
      discoveryUrl: 'https://id.test/.well-known/openid-configuration',
    });
    expect(() => buildAuth({ oauth: true, clientId: 'c', flow: 'implicit' }, 'openapi')).toThrow(/flow/);
    expect(() => buildAuth({ oauth: true, clientId: 'c', redirectPort: '99999' }, 'openapi')).toThrow(/redirect-port/);
  });
});
