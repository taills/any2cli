import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthConfig } from '../config/schema.js';
import { CliError } from '../core/errors.js';
import { interpolateDeep } from '../core/interpolate.js';
import { randomState } from './pkce.js';
import type { CredentialRecord, CredentialStore, McpCredentials } from './token-store.js';

export interface McpOAuthProviderOptions {
  name: string;
  config: McpOAuthConfig;
  store: CredentialStore;
  /** When false, needing a browser login raises AUTH_REQUIRED instead of opening one. */
  interactive: boolean;
  redirectUrl?: string;
  onAuthorizationUrl?: (url: URL) => Promise<void>;
  now?: () => number;
}

const FALLBACK_REDIRECT = 'http://127.0.0.1/callback';

/**
 * File-backed OAuthClientProvider for the MCP authorization spec: the SDK performs discovery,
 * dynamic client registration, PKCE and refresh; this class persists the results.
 */
export class FileMcpOAuthProvider implements OAuthClientProvider {
  private record: CredentialRecord;
  private verifier?: string;
  private currentState?: string;
  private readonly config: McpOAuthConfig;

  private constructor(
    private readonly options: McpOAuthProviderOptions,
    record: CredentialRecord,
  ) {
    this.record = record;
    this.config = interpolateDeep(options.config);
  }

  static async create(options: McpOAuthProviderOptions): Promise<FileMcpOAuthProvider> {
    return new FileMcpOAuthProvider(options, await options.store.read(options.name));
  }

  private get mcp(): McpCredentials {
    return this.record.mcp ?? {};
  }

  private async persist(patch: (mcp: McpCredentials) => McpCredentials): Promise<void> {
    this.record = await this.options.store.update(this.options.name, (latest) => ({ ...latest, mcp: patch(latest.mcp ?? {}) }));
  }

  get lastState(): string | undefined {
    return this.currentState;
  }

  get redirectUrl(): string {
    return this.options.redirectUrl ?? this.mcp.redirectUri ?? FALLBACK_REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'any2cli',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.clientSecret ? 'client_secret_post' : 'none',
      ...(this.config.scopes.length > 0 ? { scope: this.config.scopes.join(' ') } : {}),
    };
  }

  state(): string {
    this.currentState = randomState();
    return this.currentState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.clientId) {
      return { client_id: this.config.clientId, ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}) };
    }
    return this.mcp.clientInformation as OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.persist((mcp) => ({ ...mcp, clientInformation: info as Record<string, unknown>, redirectUri: this.redirectUrl }));
  }

  tokens(): OAuthTokens | undefined {
    return this.mcp.tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const obtainedAt = (this.options.now ?? Date.now)();
    await this.persist((mcp) => ({ ...mcp, tokens: tokens as Record<string, unknown>, obtainedAt }));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.options.interactive || !this.options.onAuthorizationUrl) {
      throw new CliError('AUTH_REQUIRED', `Target "${this.options.name}" requires a browser login`, {
        hint: `Run \`any2cli auth login ${this.options.name}\``,
      });
    }
    await this.options.onAuthorizationUrl(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new CliError('AUTH_FAILED', 'No PKCE verifier for this login attempt');
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = undefined;
      return;
    }
    await this.persist((mcp) => {
      if (scope === 'all') return {};
      const { clientInformation, tokens, discoveryState, ...rest } = mcp;
      return {
        ...rest,
        ...(scope === 'client' ? {} : clientInformation ? { clientInformation } : {}),
        ...(scope === 'tokens' ? {} : tokens ? { tokens } : {}),
        ...(scope === 'discovery' ? {} : discoveryState ? { discoveryState } : {}),
      };
    });
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.persist((mcp) => ({ ...mcp, discoveryState: state }));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.mcp.discoveryState as OAuthDiscoveryState | undefined;
  }

  /** Drops a dynamically registered client whose redirect URI no longer matches. */
  async forgetClientIfRedirectChanged(redirectUri: string): Promise<void> {
    if (this.config.clientId || !this.mcp.clientInformation || this.mcp.redirectUri === redirectUri) return;
    await this.persist(({ clientInformation: _dropped, ...rest }) => ({ ...rest, redirectUri }));
  }
}
