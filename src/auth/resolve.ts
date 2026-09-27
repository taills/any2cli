import type { AuthConfig, OAuth2Config } from '../config/schema.js';
import { CliError } from '../core/errors.js';
import { interpolate } from '../core/interpolate.js';
import type { AuthMaterial } from '../openapi/request.js';
import { clientCredentialsFlow, refreshTokenSet, resolveEndpoints } from './oauth2.js';
import type { CredentialStore, TokenSet } from './token-store.js';

export interface ResolveDeps {
  store: CredentialStore;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Tokens are refreshed this long before they actually expire. */
const EXPIRY_SKEW_MS = 60_000;
const EMPTY: AuthMaterial = { headers: {}, query: {} };

export function isExpired(tokens: TokenSet, now: number): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= now;
}

function loginRequired(name: string, cause?: unknown): CliError {
  return new CliError('AUTH_REQUIRED', `Not logged in to "${name}" (or the session expired)`, {
    hint: `Run \`anycli auth login ${name}\``,
    cause,
  });
}

async function obtainFreshTokens(name: string, config: OAuth2Config, current: TokenSet | undefined, deps: ResolveDeps): Promise<TokenSet> {
  const endpoints = await resolveEndpoints(config, deps.fetchImpl);
  if (current?.refreshToken) {
    try {
      return await refreshTokenSet(config, endpoints, current, deps);
    } catch (error) {
      if (config.flow !== 'client_credentials') throw loginRequired(name, error);
    }
  }
  if (config.flow === 'client_credentials') return clientCredentialsFlow(config, endpoints, deps);
  throw loginRequired(name);
}

/** Returns a usable OAuth2 access token, refreshing (under a lock) when it is expired or rejected. */
export async function getValidToken(name: string, config: OAuth2Config, deps: ResolveDeps, forceRefresh = false): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const cached = (await deps.store.read(name)).oauth2;
  if (cached && !forceRefresh && !isExpired(cached, now())) return cached;
  if (!cached && config.flow !== 'client_credentials') throw loginRequired(name);

  return deps.store.withLock(name, async () => {
    const record = await deps.store.read(name);
    const latest = record.oauth2;
    const refreshedByOther = latest !== undefined && latest.accessToken !== cached?.accessToken;
    if (latest && !isExpired(latest, now()) && (!forceRefresh || refreshedByOther)) return latest;
    const fresh = await obtainFreshTokens(name, config, latest, deps);
    await deps.store.writeLocked(name, { ...record, oauth2: fresh });
    return fresh;
  });
}

/** Converts a target's auth config into headers / query parameters for an outgoing request. */
export async function resolveAuthMaterial(
  name: string,
  auth: AuthConfig | undefined,
  deps: ResolveDeps,
  forceRefresh = false,
): Promise<AuthMaterial> {
  const env = deps.env ?? process.env;
  if (!auth || auth.type === 'mcp-oauth') return EMPTY;
  switch (auth.type) {
    case 'bearer':
      return { headers: { Authorization: `Bearer ${interpolate(auth.token, env)}` }, query: {} };
    case 'basic': {
      const credentials = `${interpolate(auth.username, env)}:${interpolate(auth.password, env)}`;
      return { headers: { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` }, query: {} };
    }
    case 'apiKey': {
      const value = interpolate(auth.value, env);
      if (auth.in === 'query') return { headers: {}, query: { [auth.name]: value } };
      if (auth.in === 'cookie') return { headers: { Cookie: `${auth.name}=${encodeURIComponent(value)}` }, query: {} };
      return { headers: { [auth.name]: value }, query: {} };
    }
    case 'oauth2': {
      const tokens = await getValidToken(name, auth, deps, forceRefresh);
      return { headers: { Authorization: `${tokens.tokenType} ${tokens.accessToken}` }, query: {} };
    }
  }
}
