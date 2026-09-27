import type { Command } from 'commander';
import { OAUTH2_FLOWS } from '../config/schema.js';
import { CliError } from '../core/errors.js';
import type { SecuritySummary } from '../openapi/compile.js';

export interface AuthFlags {
  bearer?: string;
  basic?: string;
  apiKey?: string;
  apiKeyName?: string;
  apiKeyIn?: string;
  oauth?: boolean;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  flow?: string;
  authUrl?: string;
  tokenUrl?: string;
  deviceUrl?: string;
  discoveryUrl?: string;
  redirectPort?: string;
  audience?: string;
}

export function addAuthOptions(command: Command): Command {
  return command
    .option('--bearer <token>', 'static bearer token (tip: pass "${ENV_VAR}" to keep it out of the config)')
    .option('--basic <user:password>', 'HTTP basic credentials')
    .option('--api-key <value>', 'API key value')
    .option('--api-key-name <name>', 'API key header/query/cookie name (default: from spec, else X-API-Key)')
    .option('--api-key-in <location>', 'header | query | cookie')
    .option('--oauth', 'enable OAuth login (`any2cli auth login <name>`)')
    .option('--client-id <id>', 'OAuth client id')
    .option('--client-secret <secret>', 'OAuth client secret (confidential clients only)')
    .option('--scopes <list>', 'OAuth scopes, comma or space separated')
    .option('--flow <flow>', `OAuth2 grant: ${OAUTH2_FLOWS.join(' | ')}`)
    .option('--auth-url <url>', 'OAuth2 authorization endpoint')
    .option('--token-url <url>', 'OAuth2 token endpoint')
    .option('--device-url <url>', 'OAuth2 device authorization endpoint')
    .option('--discovery-url <url>', 'OIDC / OAuth metadata URL (.well-known/...)')
    .option('--redirect-port <port>', 'fixed loopback port for the OAuth redirect (if your app registration requires one)')
    .option('--audience <audience>', 'OAuth2 audience parameter');
}

function splitList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(/[,\s]+/).filter(Boolean);
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError('USAGE', `Invalid --redirect-port "${value}"`);
  return port;
}

function staticAuth(flags: AuthFlags, security: readonly SecuritySummary[]): Record<string, unknown> | undefined {
  if (flags.bearer !== undefined) return { type: 'bearer', token: flags.bearer };
  if (flags.basic !== undefined) {
    const index = flags.basic.indexOf(':');
    if (index === -1) throw new CliError('USAGE', '--basic expects user:password');
    return { type: 'basic', username: flags.basic.slice(0, index), password: flags.basic.slice(index + 1) };
  }
  if (flags.apiKey !== undefined) {
    const declared = security.find((scheme) => scheme.type === 'apiKey');
    const location = flags.apiKeyIn ?? declared?.in ?? 'header';
    if (!['header', 'query', 'cookie'].includes(location)) throw new CliError('USAGE', `Invalid --api-key-in "${location}"`);
    return { type: 'apiKey', in: location, name: flags.apiKeyName ?? declared?.paramName ?? 'X-API-Key', value: flags.apiKey };
  }
  return undefined;
}

function wantsOAuth(flags: AuthFlags): boolean {
  return Boolean(flags.oauth || flags.clientId || flags.tokenUrl || flags.authUrl || flags.discoveryUrl || flags.deviceUrl || flags.flow);
}

function oauth2Auth(flags: AuthFlags, security: readonly SecuritySummary[]): Record<string, unknown> {
  const declared = security.find((scheme) => scheme.type === 'oauth2' || scheme.type === 'openIdConnect');
  if (!flags.clientId) {
    throw new CliError('USAGE', 'OAuth2 needs --client-id', {
      hint: 'Register an OAuth app with the provider using redirect URI http://127.0.0.1:<port>/callback (add --redirect-port <port> if it must be fixed)',
    });
  }
  const flow = flags.flow ?? declared?.flow ?? 'authorization_code';
  if (!(OAUTH2_FLOWS as readonly string[]).includes(flow)) throw new CliError('USAGE', `Invalid --flow "${flow}"`);
  const entries: Record<string, unknown> = {
    type: 'oauth2',
    flow,
    clientId: flags.clientId,
    clientSecret: flags.clientSecret,
    authorizationUrl: flags.authUrl ?? declared?.authorizationUrl,
    tokenUrl: flags.tokenUrl ?? declared?.tokenUrl,
    deviceAuthorizationUrl: flags.deviceUrl,
    discoveryUrl: flags.discoveryUrl ?? declared?.discoveryUrl,
    scopes: splitList(flags.scopes) ?? declared?.scopes,
    audience: flags.audience,
    redirectPort: parsePort(flags.redirectPort),
  };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

/**
 * Builds the `auth` block of a target from CLI flags. For remote MCP servers `--oauth` without
 * explicit endpoints means "MCP authorization spec" (discovery + dynamic registration).
 */
export function buildAuth(flags: AuthFlags, kind: 'mcp' | 'openapi', security: readonly SecuritySummary[] = []): Record<string, unknown> | undefined {
  const chosen = [flags.bearer, flags.basic, flags.apiKey].filter((value) => value !== undefined).length + (wantsOAuth(flags) ? 1 : 0);
  if (chosen > 1) throw new CliError('USAGE', 'Choose only one of --bearer, --basic, --api-key or OAuth options');
  const fixed = staticAuth(flags, security);
  if (fixed) return fixed;
  if (!wantsOAuth(flags)) return undefined;
  const explicitEndpoints = flags.tokenUrl || flags.authUrl || flags.discoveryUrl || flags.deviceUrl;
  if (kind === 'mcp' && !explicitEndpoints) {
    const entries: Record<string, unknown> = {
      type: 'mcp-oauth',
      clientId: flags.clientId,
      clientSecret: flags.clientSecret,
      scopes: splitList(flags.scopes),
      redirectPort: parsePort(flags.redirectPort),
    };
    return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
  }
  return oauth2Auth(flags, security);
}

export function hasLiteralSecret(flags: AuthFlags): boolean {
  return [flags.bearer, flags.basic, flags.apiKey, flags.clientSecret].some((value) => value !== undefined && !value.includes('${'));
}
