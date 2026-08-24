import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { z } from "zod";

import {
  DEVICE_CODE_GRANT_TYPE,
  oauthDeviceAuthorization,
  oauthProvider,
  type OAuthClientAdministrativeResponse,
} from "@better-auth/oauth-provider";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  BackofficeCliScopeAuthorizationError,
  type BackofficeCliOAuthConfig,
  BackofficeCliOAuthAuthenticationError,
  type BackofficeCliTokenResult,
  type Role,
} from "@/fragno/auth/contracts";
import { issueBackofficeJwt } from "@/fragno/auth/token-lifecycle";

const BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID = "fragno-backoffice-codemode";
const BACKOFFICE_CODEMODE_OAUTH_CLIENT_NAME = "Fragno Backoffice Codemode";
const BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT = "fragno-backoffice-oauth-bootstrap";
const BACKOFFICE_CODEMODE_OAUTH_SCOPES = ["openid", "offline_access", "backoffice"] as const;
const BACKOFFICE_CODEMODE_OAUTH_SCOPE = BACKOFFICE_CODEMODE_OAUTH_SCOPES.join(" ");
const BACKOFFICE_DEVICE_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const backofficeOAuthAccessTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  exp: z.number().int().positive(),
  client_id: z.string().min(1),
  azp: z.string().min(1),
  scope: z.string().min(1),
});
const oauthProviderJwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

type BetterAuthInstance = Pick<ReturnType<typeof betterAuth>, "handler" | "options" | "$context">;
type BetterAuthContext = Awaited<ReturnType<typeof betterAuth>["$context"]>;
type BetterAuthAdapter = BetterAuthContext["adapter"];
type AdminCreateOAuthClientEndpoint = (input: {
  headers: Headers;
  body: {
    scope: string;
    client_name: string;
    software_id: string;
    token_endpoint_auth_method: "none";
    application_type: "native";
    grant_types: string[];
  };
}) => Promise<OAuthClientAdministrativeResponse>;
type StoreOAuthClient = {
  clientId: string;
  softwareId: string | null;
  name: string | null;
  scopes: string[] | null;
  disabled: boolean | number | null;
};
type StoreOAuthResource = {
  id: string;
  identifier: string;
  name: string;
  allowedScopes: string[] | null;
  dpopBoundAccessTokensRequired: boolean | number;
  disabled: boolean | number;
  policyVersion: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
};

export type BackofficeTokenGrantResolution =
  | {
      status: "ready";
      authority: {
        userId: string;
        email: string;
        globalRole: Role;
        scope: BackofficeContextScope;
        organization: { id: string; slug: string; roles: string[] } | null;
      };
    }
  | {
      status: "organization_provisioning";
      retryAfterMs: number;
    };

export class BackofficeTokenGrantForbiddenError extends Error {
  override readonly name = "BackofficeTokenGrantForbiddenError";
}

export type ResolveBackofficeScopeTokenGrant = (
  adapter: BetterAuthAdapter,
  input: {
    userId: string;
    scope: BackofficeContextScope | null;
    organizationSelection: "preferred" | "required";
  },
) => Promise<BackofficeTokenGrantResolution>;

function generateBackofficeDeviceUserCode(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(8));
  const characters = Array.from(
    randomBytes,
    (value) =>
      BACKOFFICE_DEVICE_USER_CODE_ALPHABET[value % BACKOFFICE_DEVICE_USER_CODE_ALPHABET.length],
  ).join("");
  return `${characters.slice(0, 4)}-${characters.slice(4)}`;
}

function getAdminCreateOAuthClientEndpoint(
  auth: BetterAuthInstance,
): AdminCreateOAuthClientEndpoint {
  // Better Auth erases plugin endpoints when options are returned from a runtime factory. Keep the
  // assertion at the plugin boundary instead of widening the complete auth instance.
  return (auth as unknown as { api: { adminCreateOAuthClient: AdminCreateOAuthClientEndpoint } })
    .api.adminCreateOAuthClient;
}

async function getAuthContext(auth: BetterAuthInstance): Promise<BetterAuthContext> {
  return await auth.$context;
}

async function ensureBackofficeOAuthResource(
  adapter: BetterAuthAdapter,
  baseURL: string,
): Promise<StoreOAuthResource> {
  const existingResource = await adapter.findOne<StoreOAuthResource>({
    model: "oauthResource",
    where: [{ field: "identifier", value: baseURL }],
  });
  if (existingResource) {
    return existingResource;
  }
  return await adapter.create<StoreOAuthResource>({
    model: "oauthResource",
    data: {
      identifier: baseURL,
      name: "Fragno Backoffice",
      allowedScopes: [...BACKOFFICE_CODEMODE_OAUTH_SCOPES],
      dpopBoundAccessTokensRequired: false,
      disabled: false,
      policyVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

async function ensureBackofficeCodemodeOAuthClient(
  authContext: BetterAuthContext,
  createOAuthClient: AdminCreateOAuthClientEndpoint,
): Promise<StoreOAuthClient> {
  const adapter = authContext.adapter;
  const existingClient = await adapter.findOne<StoreOAuthClient>({
    model: "oauthClient",
    where: [{ field: "softwareId", value: BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID }],
  });
  if (existingClient) {
    return existingClient;
  }

  // Better Auth 1.7's server-only admin endpoint still requires a session-shaped caller. The
  // reference owner prevents this deployment client from requiring a persisted bootstrap user.
  const bootstrapIdentity = {
    user: {
      id: BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT,
      name: "Backoffice OAuth Bootstrap",
      email: "oauth-bootstrap@fragno.invalid",
      emailVerified: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    session: {
      id: BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT,
      token: BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT,
      userId: BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT,
      expiresAt: new Date("9999-12-31T23:59:59.999Z"),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ipAddress: null,
      userAgent: null,
    },
  };
  const previousSession = authContext.session;
  authContext.session = bootstrapIdentity;
  let createdClient: OAuthClientAdministrativeResponse;
  try {
    createdClient = await createOAuthClient({
      headers: new Headers(),
      body: {
        scope: BACKOFFICE_CODEMODE_OAUTH_SCOPE,
        client_name: BACKOFFICE_CODEMODE_OAUTH_CLIENT_NAME,
        software_id: BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID,
        token_endpoint_auth_method: "none",
        application_type: "native",
        grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
      },
    });
  } finally {
    authContext.session = previousSession;
  }
  const storedClient = await adapter.findOne<StoreOAuthClient>({
    model: "oauthClient",
    where: [{ field: "clientId", value: createdClient.client_id }],
  });
  if (!storedClient) {
    throw new Error("Backoffice codemode OAuth client was created but could not be loaded.");
  }
  return storedClient;
}

async function loadBackofficeCodemodeOAuth(
  auth: BetterAuthInstance,
  baseURL: string,
): Promise<{ authContext: BetterAuthContext; client: StoreOAuthClient }> {
  const authContext = await getAuthContext(auth);
  await ensureBackofficeOAuthResource(authContext.adapter, baseURL);
  const client = await ensureBackofficeCodemodeOAuthClient(
    authContext,
    getAdminCreateOAuthClientEndpoint(auth),
  );
  return { authContext, client };
}

export function createBackofficeOAuthPlugins(): BetterAuthPlugin[] {
  return [
    oauthProvider({
      loginPage: "/backoffice/login",
      consentPage: "/backoffice/oauth/consent",
      scopes: [...BACKOFFICE_CODEMODE_OAUTH_SCOPES],
      enforcePerClientResources: false,
      allowDynamicClientRegistration: false,
      clientReference: ({ user }) =>
        user?.id === BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT
          ? BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID
          : undefined,
    }),
    oauthDeviceAuthorization({
      verificationUri: "/backoffice/device",
      generateUserCode: generateBackofficeDeviceUserCode,
    }),
  ];
}

export async function initializeBackofficeCodemodeOAuthClient(
  auth: BetterAuthInstance,
): Promise<void> {
  const authContext = await getAuthContext(auth);
  await ensureBackofficeCodemodeOAuthClient(authContext, getAdminCreateOAuthClientEndpoint(auth));
}

export async function getBackofficeCliOAuthConfig(
  auth: BetterAuthInstance,
  input: { requestUrl: string },
): Promise<BackofficeCliOAuthConfig> {
  const baseURL = new URL(input.requestUrl).origin;
  const { client } = await loadBackofficeCodemodeOAuth(auth, baseURL);
  return {
    clientId: client.clientId,
    scope: BACKOFFICE_CODEMODE_OAUTH_SCOPE,
    deviceAuthorizationEndpoint: new URL("/api/auth/device/code", baseURL).toString(),
    tokenEndpoint: new URL("/api/auth/oauth2/token", baseURL).toString(),
    verificationUri: new URL("/backoffice/device", baseURL).toString(),
  };
}

export async function exchangeBackofficeOAuthAccessToken(
  auth: BetterAuthInstance,
  input: {
    requestUrl: string;
    oauthAccessToken: string;
    scope: BackofficeContextScope | null;
  },
  resolveGrant: ResolveBackofficeScopeTokenGrant,
): Promise<BackofficeCliTokenResult> {
  const baseURL = new URL(input.requestUrl).origin;
  const { authContext, client } = await loadBackofficeCodemodeOAuth(auth, baseURL);

  let oauthPayload: z.infer<typeof backofficeOAuthAccessTokenPayloadSchema>;
  try {
    const verifyBearerToken = oauthProviderResourceClient(auth).getActions().verifyBearerToken;
    const verifyOptions = {
      verifyOptions: { audience: baseURL },
      // The resource-client runtime accepts a JWKS loader even though its public type still
      // declares only URL strings. Loading through this Auth object avoids a network call back to
      // the same Worker while retaining the resource client's complete verification path.
      jwksUrl: async () => {
        const response = await auth.handler(new Request(new URL("/api/auth/jwks", baseURL)));
        if (!response.ok) {
          throw new Error(`OAuth provider JWKS request failed with status ${response.status}.`);
        }
        return oauthProviderJwksSchema.parse(await response.json());
      },
      requiredScopes: ["backoffice"],
    } as unknown as Parameters<typeof verifyBearerToken>[1];
    const verifiedPayload = await verifyBearerToken(input.oauthAccessToken, verifyOptions);
    oauthPayload = backofficeOAuthAccessTokenPayloadSchema.parse(verifiedPayload);
    const clientDisabled = client.disabled === true || client.disabled === 1;
    if (
      clientDisabled ||
      oauthPayload.client_id !== client.clientId ||
      oauthPayload.azp !== client.clientId ||
      oauthPayload.exp * 1_000 <= Date.now()
    ) {
      throw new Error("OAuth access token does not belong to the Backoffice codemode client.");
    }
  } catch (error) {
    throw new BackofficeCliOAuthAuthenticationError(
      "The OAuth access token is invalid for Backoffice codemode.",
      { cause: error },
    );
  }

  let grant: BackofficeTokenGrantResolution;
  try {
    grant = await resolveGrant(authContext.adapter, {
      userId: oauthPayload.sub,
      scope: input.scope,
      organizationSelection: input.scope ? "required" : "preferred",
    });
  } catch (error) {
    if (error instanceof BackofficeTokenGrantForbiddenError) {
      throw new BackofficeCliScopeAuthorizationError(error.message, { cause: error });
    }
    throw error;
  }
  if (grant.status === "organization_provisioning") {
    throw new BackofficeCliScopeAuthorizationError(
      "The authenticated user does not have an available Backoffice organization.",
    );
  }

  const issued = await issueBackofficeJwt(
    { context: authContext } as Parameters<typeof issueBackofficeJwt>[0],
    grant.authority,
  );
  return {
    accessToken: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    scope: grant.authority.scope,
  };
}
