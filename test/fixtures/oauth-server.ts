import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockOAuthServer {
  url: string;
  /** Access tokens currently valid. */
  validTokens: Set<string>;
  grants: string[];
  lastAuthorizeParams?: URLSearchParams;
  registeredClients: Array<Record<string, unknown>>;
  /** Makes /authorize redirect back with `error=access_denied`. */
  deny: boolean;
  /** Number of `authorization_pending` answers before a device code is approved. */
  devicePendingPolls: number;
  expiresIn: number;
  close(): Promise<void>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge?: string;
  scope?: string;
}

const b64url = (buffer: Buffer): string => buffer.toString('base64url');
const token = (prefix: string): string => `${prefix}-${randomBytes(6).toString('hex')}`;

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export interface MockOAuthOptions {
  clientSecret?: string;
  /** Answer token requests as application/x-www-form-urlencoded (like GitHub without Accept). */
  formResponses?: boolean;
}

export async function startMockOAuthServer(options: MockOAuthOptions = {}): Promise<MockOAuthServer> {
  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, string>();
  const devicePolls = new Map<string, number>();

  const state: MockOAuthServer = {
    url: '',
    validTokens: new Set(),
    grants: [],
    registeredClients: [],
    deny: false,
    devicePendingPolls: 1,
    expiresIn: 3600,
    close: async () => undefined,
  };

  const issue = (res: ServerResponse, scope?: string): void => {
    const access = token('at');
    const refresh = token('rt');
    state.validTokens.add(access);
    refreshTokens.set(refresh, scope ?? '');
    const body = { access_token: access, token_type: 'bearer', expires_in: state.expiresIn, refresh_token: refresh, scope: scope ?? '' };
    if (options.formResponses) {
      res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' }).end(new URLSearchParams(body as never).toString());
    } else {
      json(res, 200, body);
    }
  };

  const clientOk = (req: IncomingMessage, form: URLSearchParams): boolean => {
    if (!options.clientSecret) return true;
    const basic = req.headers.authorization?.startsWith('Basic ')
      ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8').split(':')[1]
      : undefined;
    return (form.get('client_secret') ?? (basic ? decodeURIComponent(basic) : undefined)) === options.clientSecret;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', state.url);
    if (url.pathname === '/.well-known/openid-configuration' || url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: state.url,
        authorization_endpoint: `${state.url}/authorize`,
        token_endpoint: `${state.url}/token`,
        device_authorization_endpoint: `${state.url}/device`,
        registration_endpoint: `${state.url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      });
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const client = { ...metadata, client_id: token('client'), client_id_issued_at: Math.floor(Date.now() / 1000) };
      state.registeredClients.push(client);
      json(res, 201, client);
      return;
    }
    if (url.pathname === '/authorize') {
      const params = url.searchParams;
      state.lastAuthorizeParams = params;
      const redirect = new URL(params.get('redirect_uri') ?? '');
      if (params.get('state')) redirect.searchParams.set('state', params.get('state') as string);
      if (state.deny) {
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', 'User <b>denied</b> access');
      } else {
        const code = token('code');
        codes.set(code, {
          clientId: params.get('client_id') ?? '',
          redirectUri: params.get('redirect_uri') ?? '',
          challenge: params.get('code_challenge') ?? undefined,
          scope: params.get('scope') ?? undefined,
        });
        redirect.searchParams.set('code', code);
      }
      res.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    if (url.pathname === '/device' && req.method === 'POST') {
      const deviceCode = token('dc');
      devicePolls.set(deviceCode, 0);
      json(res, 200, {
        device_code: deviceCode,
        user_code: 'WDJB-MJHT',
        verification_uri: `${state.url}/activate`,
        verification_uri_complete: `${state.url}/activate?user_code=WDJB-MJHT`,
        expires_in: 600,
        interval: 0,
      });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = await readForm(req);
      const grant = form.get('grant_type') ?? '';
      state.grants.push(grant);
      if (!clientOk(req, form)) {
        json(res, 401, { error: 'invalid_client', error_description: 'bad client secret' });
        return;
      }
      if (grant === 'authorization_code') {
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challengeOk = !pending?.challenge || b64url(createHash('sha256').update(verifier).digest()) === pending.challenge;
        if (!pending || pending.redirectUri !== form.get('redirect_uri') || !challengeOk) {
          json(res, 400, { error: 'invalid_grant', error_description: 'code, redirect_uri or PKCE verifier mismatch' });
          return;
        }
        issue(res, pending.scope);
        return;
      }
      if (grant === 'refresh_token') {
        const refresh = form.get('refresh_token') ?? '';
        if (!refreshTokens.has(refresh)) {
          json(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
          return;
        }
        const scope = refreshTokens.get(refresh);
        refreshTokens.delete(refresh);
        issue(res, scope);
        return;
      }
      if (grant === 'client_credentials') {
        issue(res, form.get('scope') ?? undefined);
        return;
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const deviceCode = form.get('device_code') ?? '';
        const polls = devicePolls.get(deviceCode);
        if (polls === undefined) {
          json(res, 400, { error: 'expired_token' });
          return;
        }
        devicePolls.set(deviceCode, polls + 1);
        if (polls < state.devicePendingPolls) {
          json(res, 400, { error: polls === 0 ? 'authorization_pending' : 'slow_down' });
          return;
        }
        devicePolls.delete(deviceCode);
        issue(res);
        return;
      }
      json(res, 400, { error: 'unsupported_grant_type' });
      return;
    }
    res.writeHead(404).end();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => json(res, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

/** Plays the role of the user's browser: follows the authorize redirect to the local callback. */
export async function fakeBrowser(url: string): Promise<boolean> {
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location) await fetch(location);
  return true;
}
