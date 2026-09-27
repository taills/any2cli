import type { OAuth2Config } from '../config/schema.js';
import { CliError } from '../core/errors.js';
import { interpolateDeep } from '../core/interpolate.js';
import { startCallbackServer, type CallbackServer, type CallbackServerOptions } from './callback-server.js';
import { createPkce, randomState } from './pkce.js';
import type { TokenSet } from './token-store.js';

export interface Endpoints {
  authorizationUrl?: string;
  tokenUrl: string;
  deviceAuthorizationUrl?: string;
}

export interface FlowDeps {
  log: (line: string) => void;
  openUrl: (url: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the user in the browser / on the device page. */
  timeoutMs?: number;
  startServer?: (options: CallbackServerOptions) => Promise<CallbackServer>;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Kept well below the credential lock's stale threshold, so a hung endpoint never outlives the lock. */
const OAUTH_HTTP_TIMEOUT_MS = 20_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

type Json = Record<string, unknown>;

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<Json> {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS) }).catch((error: unknown) => {
    throw new CliError('CONNECTION', `Cannot reach ${url}: ${(error as Error).message}`);
  });
  if (!response.ok) throw new CliError('CONFIG', `Discovery document ${url} returned HTTP ${response.status}`);
  return (await response.json()) as Json;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Credentials and codes must never travel in clear text, except to the local machine. */
export function assertSecureEndpoint(kind: string, url: string | undefined): void {
  if (url === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError('CONFIG', `OAuth2 ${kind} URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) return;
  throw new CliError('CONFIG', `OAuth2 ${kind} URL must use https: ${url}`, {
    hint: 'Plain http is only allowed for localhost; check the endpoint in the target config or the spec',
  });
}

/** Fills in missing endpoints from `discoveryUrl` (OIDC / RFC 8414). */
export async function resolveEndpoints(config: OAuth2Config, fetchImpl: typeof fetch = fetch): Promise<Endpoints> {
  const resolved = interpolateDeep(config);
  assertSecureEndpoint('discovery', resolved.discoveryUrl);
  const discovered = resolved.discoveryUrl ? await fetchJson(resolved.discoveryUrl, fetchImpl) : {};
  const pick = (own: string | undefined, key: string): string | undefined =>
    own ?? (typeof discovered[key] === 'string' ? (discovered[key] as string) : undefined);
  const tokenUrl = pick(resolved.tokenUrl, 'token_endpoint');
  if (!tokenUrl) {
    throw new CliError('CONFIG', 'OAuth2 config has no token URL', {
      hint: 'Set tokenUrl, or discoveryUrl pointing at /.well-known/openid-configuration',
    });
  }
  const authorizationUrl = pick(resolved.authorizationUrl, 'authorization_endpoint');
  const deviceAuthorizationUrl = pick(resolved.deviceAuthorizationUrl, 'device_authorization_endpoint');
  assertSecureEndpoint('token', tokenUrl);
  assertSecureEndpoint('authorization', authorizationUrl);
  assertSecureEndpoint('device authorization', deviceAuthorizationUrl);
  return { ...(authorizationUrl ? { authorizationUrl } : {}), tokenUrl, ...(deviceAuthorizationUrl ? { deviceAuthorizationUrl } : {}) };
}

async function parseBody(response: Response): Promise<Json> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

interface TokenEndpointResult {
  ok: boolean;
  data: Json;
  status: number;
}

async function postToken(config: OAuth2Config, url: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenEndpointResult> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
  body.set('client_id', config.clientId);
  if (config.clientSecret) {
    if (config.tokenAuthMethod === 'client_secret_basic') {
      const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
      body.delete('client_id');
    } else {
      body.set('client_secret', config.clientSecret);
    }
  }
  const response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS) }).catch((error: unknown) => {
    throw new CliError('CONNECTION', `Cannot reach token endpoint ${url}: ${(error as Error).message}`);
  });
  const data = await parseBody(response);
  return { ok: response.ok && typeof data.error !== 'string', data, status: response.status };
}

function tokenError(result: TokenEndpointResult): CliError {
  const error = typeof result.data.error === 'string' ? result.data.error : `HTTP ${result.status}`;
  const description = typeof result.data.error_description === 'string' ? `: ${result.data.error_description}` : '';
  return new CliError('AUTH_FAILED', `Token request failed (${error}${description})`);
}

function toTokenSet(data: Json, now: number, previous?: TokenSet): TokenSet {
  if (typeof data.access_token !== 'string') throw new CliError('AUTH_FAILED', 'Token response did not contain an access_token');
  const type = typeof data.token_type === 'string' ? data.token_type : 'Bearer';
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    tokenType: type.toLowerCase() === 'bearer' ? 'Bearer' : type,
    ...(typeof data.refresh_token === 'string'
      ? { refreshToken: data.refresh_token }
      : previous?.refreshToken
        ? { refreshToken: previous.refreshToken }
        : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(typeof data.scope === 'string' && data.scope ? { scope: data.scope } : {}),
    ...(typeof data.id_token === 'string' ? { idToken: data.id_token } : {}),
    obtainedAt: now,
  };
}

async function requestTokens(config: OAuth2Config, endpoints: Endpoints, params: Record<string, string>, deps: Pick<FlowDeps, 'fetchImpl' | 'now'>, previous?: TokenSet): Promise<TokenSet> {
  const result = await postToken(config, endpoints.tokenUrl, params, deps.fetchImpl ?? fetch);
  if (!result.ok) throw tokenError(result);
  return toTokenSet(result.data, (deps.now ?? Date.now)(), previous);
}

function scopeParams(config: OAuth2Config): Record<string, string> {
  return {
    ...(config.scopes.length > 0 ? { scope: config.scopes.join(' ') } : {}),
    ...(config.audience ? { audience: config.audience } : {}),
  };
}

async function announce(url: string, deps: FlowDeps, what: string): Promise<void> {
  const opened = await deps.openUrl(url).catch(() => false);
  deps.log(opened ? `Opened your browser to ${what}. If nothing happened, open this URL:` : `Open this URL in a browser to ${what}:`);
  deps.log(`  ${url}`);
}

/** Authorization Code grant with PKCE and a loopback redirect (RFC 6749 §4.1, RFC 7636, RFC 8252). */
export async function authorizationCodeFlow(rawConfig: OAuth2Config, endpoints: Endpoints, deps: FlowDeps): Promise<TokenSet> {
  const config = interpolateDeep(rawConfig);
  if (!endpoints.authorizationUrl) {
    throw new CliError('CONFIG', 'OAuth2 config has no authorization URL', { hint: 'Set authorizationUrl or discoveryUrl' });
  }
  const server = await (deps.startServer ?? startCallbackServer)({
    port: config.redirectPort,
    host: config.redirectHost,
    path: config.redirectPath,
  });
  try {
    const pkce = createPkce();
    const state = randomState();
    const url = new URL(endpoints.authorizationUrl);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: server.redirectUri,
      state,
      ...scopeParams(config),
      ...(config.pkce ? { code_challenge: pkce.challenge, code_challenge_method: pkce.method } : {}),
      ...config.extraAuthParams,
    };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    await announce(url.toString(), deps, 'authorize any2cli');
    const code = await server.waitForCode(state, deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    return await requestTokens(config, endpoints, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: server.redirectUri,
      ...(config.pkce ? { code_verifier: pkce.verifier } : {}),
    }, deps);
  } finally {
    await server.close();
  }
}

/** Device Authorization grant (RFC 8628) for machines without a usable browser. */
export async function deviceCodeFlow(rawConfig: OAuth2Config, endpoints: Endpoints, deps: FlowDeps): Promise<TokenSet> {
  const config = interpolateDeep(rawConfig);
  if (!endpoints.deviceAuthorizationUrl) {
    throw new CliError('CONFIG', 'OAuth2 config has no device authorization URL', {
      hint: 'Set deviceAuthorizationUrl or discoveryUrl, or use the authorization_code flow',
    });
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const start = await postToken(config, endpoints.deviceAuthorizationUrl, scopeParams(config), fetchImpl);
  if (!start.ok || typeof start.data.device_code !== 'string') throw tokenError(start);
  const { device_code: deviceCode, user_code: userCode } = start.data as { device_code: string; user_code?: string };
  const verification = String(start.data.verification_uri_complete ?? start.data.verification_uri ?? '');
  deps.log(`Your one-time code: ${userCode ?? '(embedded in the link)'}`);
  await announce(verification, deps, 'approve this device');

  const expiresIn = Number(start.data.expires_in);
  const deadline = now() + Math.min(Number.isFinite(expiresIn) ? expiresIn * 1000 : Infinity, deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS * 3);
  let interval = Number(start.data.interval) > 0 ? Number(start.data.interval) : 5;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const result = await postToken(config, endpoints.tokenUrl, { grant_type: DEVICE_GRANT, device_code: deviceCode }, fetchImpl);
    if (result.ok) return toTokenSet(result.data, now());
    if (result.data.error === 'authorization_pending') continue;
    if (result.data.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw tokenError(result);
  }
  throw new CliError('AUTH_FAILED', 'The device code expired before it was approved');
}

export async function clientCredentialsFlow(rawConfig: OAuth2Config, endpoints: Endpoints, deps: Pick<FlowDeps, 'fetchImpl' | 'now'> = {}): Promise<TokenSet> {
  const config = interpolateDeep(rawConfig);
  return requestTokens(config, endpoints, { grant_type: 'client_credentials', ...scopeParams(config) }, deps);
}

export async function refreshTokenSet(rawConfig: OAuth2Config, endpoints: Endpoints, tokens: TokenSet, deps: Pick<FlowDeps, 'fetchImpl' | 'now'> = {}): Promise<TokenSet> {
  if (!tokens.refreshToken) throw new CliError('AUTH_REQUIRED', 'No refresh token available');
  const config = interpolateDeep(rawConfig);
  return requestTokens(config, endpoints, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, deps, tokens);
}
