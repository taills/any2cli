import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError } from '../core/errors.js';

export interface CallbackServer {
  redirectUri: string;
  port: number;
  /** Resolves with the authorization code once the browser hits the redirect URI. */
  waitForCode(expectedState: string | undefined, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export interface CallbackServerOptions {
  port?: number;
  host?: '127.0.0.1' | 'localhost';
  path?: string;
}

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>any2cli</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body></html>`;
}

function listen(server: Server, port: number, address: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new CliError('CONFIG', `Port ${port} is already in use; cannot receive the OAuth redirect`, {
              hint: 'Free the port or set a different redirectPort for this target',
            })
          : error,
      );
    });
    server.listen(port, address, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** With a `localhost` redirect the browser may resolve to ::1, so listen there too (best effort). */
async function listenIpv6(handler: RequestListener, port: number): Promise<Server | undefined> {
  const server = createServer(handler);
  try {
    await listen(server, port, '::1');
    return server;
  } catch {
    await closeServer(server);
    return undefined;
  }
}

/**
 * Starts a one-shot loopback HTTP server (RFC 8252 §7.3) that receives the OAuth redirect.
 * It only listens on loopback addresses and only accepts the first request to the callback path.
 */
export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  const path = options.path ?? '/callback';
  let deliver: (result: CallbackResult) => void = () => undefined;
  const received = new Promise<CallbackResult>((resolve) => {
    deliver = resolve;
  });
  let handled = false;

  const handler: RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path || handled) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    handled = true;
    const result: CallbackResult = {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
      errorDescription: url.searchParams.get('error_description') ?? undefined,
    };
    const failed = result.error !== undefined || result.code === undefined;
    const body = failed
      ? page('Authorization failed', `${result.error ?? 'no code received'}: ${result.errorDescription ?? ''}`)
      : page('Authorization complete', 'You can close this window and return to the terminal.');
    res.writeHead(failed ? 400 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
    deliver(result);
  };

  const server = createServer(handler);
  await listen(server, options.port ?? 0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';
  const ipv6 = host === 'localhost' ? await listenIpv6(handler, port) : undefined;
  const servers = ipv6 ? [server, ipv6] : [server];

  return {
    port,
    redirectUri: `http://${host}:${port}${path}`,
    async waitForCode(expectedState, timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CliError('AUTH_FAILED', `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser redirect`)),
          timeoutMs,
        );
      });
      try {
        const result = await Promise.race([received, timeout]);
        if (result.error) {
          throw new CliError('AUTH_FAILED', `Authorization was rejected: ${result.error}${result.errorDescription ? ` (${result.errorDescription})` : ''}`);
        }
        if (expectedState !== undefined && result.state !== expectedState) {
          throw new CliError('AUTH_FAILED', 'OAuth state mismatch; the redirect did not come from this login attempt');
        }
        if (!result.code) throw new CliError('AUTH_FAILED', 'The redirect did not include an authorization code');
        return result.code;
      } finally {
        clearTimeout(timer);
      }
    },
    close: async () => {
      await Promise.all(servers.map(closeServer));
    },
  };
}
