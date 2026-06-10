import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface OAuthProviderSnapshot {
  serverId: string;
  endpointUrl: string;
  redirectUrl?: string;
  scope?: string;
  stateId?: string;
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
  flow?: "authorization_code" | "client_credentials";
  oauthState?: {
    id: string;
    codeVerifier: string;
    redirectUri: string;
    scope?: string;
    expiresAt: Date;
    consumedAt?: Date | null;
  };
}

export interface OAuthProviderChanges {
  authorizationUrl?: URL;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
  oauthState?: {
    id: string;
    codeVerifier: string;
    redirectUri: string;
    scope?: string;
    expiresAt: Date;
  };
  consumeStateId?: string;
  invalidate?: "all" | "client" | "tokens" | "verifier" | "discovery";
}

export class BufferedOAuthClientProvider implements OAuthClientProvider {
  readonly changes: OAuthProviderChanges = {};

  constructor(private readonly snapshot: OAuthProviderSnapshot) {}

  get redirectUrl() {
    return this.snapshot.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    if (this.snapshot.flow === "client_credentials") {
      return {
        redirect_uris: [],
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["client_credentials"],
        client_name: this.snapshot.clientName ?? "Fragno MCP Fragment",
        scope: this.snapshot.scope,
      };
    }
    return {
      redirect_uris: this.snapshot.redirectUrl ? [this.snapshot.redirectUrl] : [],
      token_endpoint_auth_method: this.snapshot.clientSecret ? "client_secret_basic" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.snapshot.clientName ?? "Fragno MCP Fragment",
      scope: this.snapshot.scope,
    };
  }

  state() {
    if (!this.snapshot.stateId) {
      throw new Error("OAuth state is required to start authorization");
    }
    return this.snapshot.stateId;
  }

  clientInformation() {
    if (this.snapshot.clientId) {
      const clientInformation = {
        client_id: this.snapshot.clientId,
        client_secret: this.snapshot.clientSecret,
      };
      this.changes.clientInformation ??= clientInformation;
      return clientInformation;
    }
    return this.changes.clientInformation ?? this.snapshot.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    this.changes.clientInformation = clientInformation;
  }

  tokens() {
    return this.changes.tokens ?? this.snapshot.tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.changes.tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.changes.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string) {
    if (this.snapshot.flow === "client_credentials") {
      return;
    }
    if (!this.snapshot.stateId || !this.snapshot.redirectUrl) {
      throw new Error("OAuth state and redirect URL are required");
    }
    this.changes.oauthState = {
      id: this.snapshot.stateId,
      codeVerifier,
      redirectUri: this.snapshot.redirectUrl,
      scope: this.snapshot.scope,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };
  }

  codeVerifier() {
    if (this.snapshot.flow === "client_credentials") {
      throw new Error("codeVerifier is not used for client_credentials flow");
    }
    const state = this.snapshot.oauthState;
    if (!state || state.consumedAt) {
      throw new Error("Invalid OAuth state");
    }
    if (state.expiresAt.getTime() < Date.now()) {
      throw new Error("OAuth state expired");
    }
    return state.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.changes.discoveryState = state;
  }

  discoveryState() {
    return this.changes.discoveryState ?? this.snapshot.discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    this.changes.invalidate = scope;
  }

  prepareTokenRequest(scope?: string) {
    if (this.snapshot.flow !== "client_credentials") {
      return undefined;
    }
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope) {
      params.set("scope", scope);
    }
    return params;
  }

  consumeState() {
    if (this.snapshot.stateId) {
      this.changes.consumeStateId = this.snapshot.stateId;
    }
  }
}
