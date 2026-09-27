import { z } from 'zod';
import { CliError } from '../core/errors.js';

const stringMap = z.record(z.string(), z.string());
const port = z.number().int().min(0).max(65535);
const redirectHost = z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1');

const bearerAuth = z.object({ type: z.literal('bearer'), token: z.string().min(1) });
const basicAuth = z.object({ type: z.literal('basic'), username: z.string(), password: z.string() });
const apiKeyAuth = z.object({
  type: z.literal('apiKey'),
  in: z.enum(['header', 'query', 'cookie']).default('header'),
  name: z.string().min(1),
  value: z.string(),
});

export const OAUTH2_FLOWS = ['authorization_code', 'device_code', 'client_credentials'] as const;

const oauth2Auth = z.object({
  type: z.literal('oauth2'),
  flow: z.enum(OAUTH2_FLOWS).default('authorization_code'),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  tokenAuthMethod: z.enum(['client_secret_post', 'client_secret_basic']).default('client_secret_post'),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  deviceAuthorizationUrl: z.string().optional(),
  /** OIDC / RFC 8414 discovery document URL, used to fill in missing endpoints. */
  discoveryUrl: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  audience: z.string().optional(),
  redirectPort: port.optional(),
  redirectHost,
  redirectPath: z.string().startsWith('/').default('/callback'),
  extraAuthParams: stringMap.optional(),
  pkce: z.boolean().default(true),
});

/** OAuth as defined by the MCP authorization spec (discovery + dynamic client registration). */
const mcpOAuth = z.object({
  type: z.literal('mcp-oauth'),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  redirectPort: port.optional(),
  redirectHost,
});

const httpAuth = z.discriminatedUnion('type', [bearerAuth, basicAuth, apiKeyAuth, oauth2Auth, mcpOAuth]);
const openApiAuth = z.discriminatedUnion('type', [bearerAuth, basicAuth, apiKeyAuth, oauth2Auth]);

const common = {
  description: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
};

const stdioTarget = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: stringMap.default({}),
  cwd: z.string().optional(),
  ...common,
});

const remoteTarget = {
  url: z.string().url(),
  headers: stringMap.default({}),
  auth: httpAuth.optional(),
  ...common,
};

const httpTarget = z.object({ type: z.literal('http'), ...remoteTarget });
const sseTarget = z.object({ type: z.literal('sse'), ...remoteTarget });

const openApiTarget = z.object({
  type: z.literal('openapi'),
  spec: z.string().min(1),
  baseUrl: z.string().optional(),
  headers: stringMap.default({}),
  auth: openApiAuth.optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  ...common,
});

export const targetSchema = z.discriminatedUnion('type', [stdioTarget, httpTarget, sseTarget, openApiTarget]);

export type Target = z.infer<typeof targetSchema>;
export type StdioTarget = z.infer<typeof stdioTarget>;
export type HttpTarget = z.infer<typeof httpTarget>;
export type SseTarget = z.infer<typeof sseTarget>;
export type RemoteMcpTarget = HttpTarget | SseTarget;
export type OpenApiTarget = z.infer<typeof openApiTarget>;
export type McpTarget = StdioTarget | RemoteMcpTarget;
export type AuthConfig = z.infer<typeof httpAuth>;
export type OAuth2Config = z.infer<typeof oauth2Auth>;
export type McpOAuthConfig = z.infer<typeof mcpOAuth>;

export const DEFAULT_TIMEOUT_MS = 60_000;

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

export function parseTarget(input: unknown, name?: string): Target {
  const result = targetSchema.safeParse(input);
  if (result.success) return result.data;
  const label = name === undefined ? 'target' : `target "${name}"`;
  throw new CliError('CONFIG', `Invalid ${label}: ${formatZodError(result.error)}`);
}

export function isMcpTarget(target: Target): target is McpTarget {
  return target.type !== 'openapi';
}
