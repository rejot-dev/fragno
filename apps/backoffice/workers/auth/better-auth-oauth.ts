import { betterAuth, type BetterAuthPlugin } from "better-auth";

import { Cursor, decodeCursor } from "@fragno-dev/db";

import {
  DEVICE_CODE_GRANT_TYPE,
  oauthDeviceAuthorization,
  oauthProvider,
  type OAuthClientAdministrativeResponse,
} from "@better-auth/oauth-provider";

import type { BackofficeCliOAuthConfig } from "@/fragno/auth/contracts";
import {
  BACKOFFICE_OAUTH_SCOPES,
  type BackofficeOAuthClientCreateInput,
  type BackofficeOAuthClientCreateResult,
  type BackofficeOAuthClientListInput,
  type BackofficeOAuthClientPage,
  type BackofficeOAuthClientSummary,
} from "@/fragno/auth/oauth-client";

import type { BackofficeOAuthExecutionPolicy } from "./backoffice-execution-token";
import { enforceBackofficeOAuthTokenResponseConsent } from "./better-auth-oauth-consent";

const BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID = "fragno-backoffice-codemode";
const BACKOFFICE_CODEMODE_OAUTH_CLIENT_NAME = "Fragno Backoffice Codemode";
const BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT = "fragno-backoffice-oauth-bootstrap";
const BACKOFFICE_CODEMODE_OAUTH_SCOPES = ["openid", "offline_access", "backoffice"] as const;
const BACKOFFICE_CODEMODE_OAUTH_SCOPE = BACKOFFICE_CODEMODE_OAUTH_SCOPES.join(" ");
const BACKOFFICE_DEVICE_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type BetterAuthInstance = Pick<ReturnType<typeof betterAuth>, "handler" | "options" | "$context">;
type BetterAuthContext = Awaited<ReturnType<typeof betterAuth>["$context"]>;
type BetterAuthAdapter = BetterAuthContext["adapter"];
type AdminCreateOAuthClientEndpoint = (input: {
  headers: Headers;
  body: {
    scope: string;
    client_name: string;
    software_id?: string;
    redirect_uris?: string[];
    token_endpoint_auth_method: "none" | "client_secret_basic";
    application_type: "native" | "web";
    grant_types: string[];
    require_pkce?: boolean;
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
    // Managed clients can claim the same software metadata, but not the bootstrap reference owner.
    where: [
      { field: "softwareId", value: BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID },
      { field: "referenceId", value: BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID },
    ],
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

/** Restricts managed OAuth client operations using live global administrator authority. */
export function createBackofficeOAuthPlugins(input: {
  isUserAdministrator: ((userId: string) => Promise<boolean>) | null;
}): BetterAuthPlugin[] {
  return [
    oauthProvider({
      loginPage: "/backoffice/login",
      consentPage: "/backoffice/oauth/consent",
      scopes: [...BACKOFFICE_OAUTH_SCOPES],
      enforcePerClientResources: false,
      allowDynamicClientRegistration: false,
      customTokenResponseFields: enforceBackofficeOAuthTokenResponseConsent,
      clientPrivileges: async function authorizeOAuthClientManagement({ action, user }) {
        if (!user) {
          return false;
        }
        // This server-only bootstrap has no persisted user or session. It may only create its client.
        if (user.id === BACKOFFICE_CODEMODE_OAUTH_BOOTSTRAP_SUBJECT) {
          return action === "create";
        }
        return input.isUserAdministrator !== null && (await input.isUserAdministrator(user.id));
      },
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

function decodeOAuthClientListCursor(input: BackofficeOAuthClientListInput): string | null {
  if (input.cursor === null) {
    return null;
  }
  try {
    const cursor = decodeCursor(input.cursor);
    if (
      cursor.indexName !== "oauthClient.clientId" ||
      cursor.orderDirection !== "asc" ||
      cursor.pageSize !== input.pageSize ||
      typeof cursor.indexValues.clientId !== "string" ||
      cursor.indexValues.clientId.length === 0
    ) {
      throw new Error("Cursor does not match the OAuth client catalog.");
    }
    return cursor.indexValues.clientId;
  } catch {
    throw new Error("Admin OAuth client listing cursor is invalid.");
  }
}

/** Reads a bounded global metadata projection through Auth, without selecting credential columns. */
export async function listBackofficeOAuthClients(
  auth: BetterAuthInstance,
  input: BackofficeOAuthClientListInput,
): Promise<BackofficeOAuthClientPage> {
  const afterClientId = decodeOAuthClientListCursor(input);
  const { adapter } = await getAuthContext(auth);
  const rows = await adapter.findMany<BackofficeOAuthClientSummary>({
    model: "oauthClient",
    select: [
      "clientId",
      "name",
      "redirectUris",
      "scopes",
      "tokenEndpointAuthMethod",
      "userId",
      "referenceId",
      "disabled",
    ],
    where:
      afterClientId === null ? [] : [{ field: "clientId", operator: "gt", value: afterClientId }],
    sortBy: { field: "clientId", direction: "asc" },
    limit: input.pageSize + 1,
  });
  const hasNextPage = rows.length > input.pageSize;
  const clients = rows.slice(0, input.pageSize).map((client) => ({
    clientId: client.clientId,
    name: client.name,
    redirectUris: client.redirectUris,
    scopes: client.scopes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    userId: client.userId,
    referenceId: client.referenceId,
    disabled: client.disabled,
  }));
  return {
    clients,
    hasNextPage,
    nextCursor: hasNextPage
      ? new Cursor({
          indexName: "oauthClient.clientId",
          orderDirection: "asc",
          pageSize: input.pageSize,
          indexValues: { clientId: clients[clients.length - 1].clientId },
        }).encode()
      : null,
  };
}

/** Uses an isolated Auth instance so synthetic server session state cannot leak to HTTP requests. */
export async function createBackofficeAdminOAuthClient(
  auth: BetterAuthInstance,
  input: BackofficeOAuthClientCreateInput & { administratorUserId: string },
): Promise<BackofficeOAuthClientCreateResult> {
  const authContext = await getAuthContext(auth);
  const user = await authContext.internalAdapter.findUserById(input.administratorUserId);
  if (!user) {
    throw new Error("Admin OAuth client creation requires an existing administrator user.");
  }
  const now = new Date();
  authContext.session = {
    user,
    session: {
      id: "backoffice-admin-oauth-client-create",
      token: "backoffice-admin-oauth-client-create",
      userId: user.id,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  };
  const createClient = getAdminCreateOAuthClientEndpoint(auth);
  try {
    const client = await createClient({
      headers: new Headers(),
      body: {
        client_name: input.name,
        redirect_uris: input.redirectUris,
        scope: input.scopes.join(" "),
        token_endpoint_auth_method: input.clientType === "public" ? "none" : "client_secret_basic",
        application_type: input.applicationType,
        require_pkce: true,
        grant_types: input.scopes.includes("offline_access")
          ? ["authorization_code", "refresh_token"]
          : ["authorization_code"],
      },
    });
    return input.clientType === "public"
      ? { clientType: "public", clientId: client.client_id, clientSecret: null }
      : {
          clientType: "confidential",
          clientId: client.client_id,
          // Better Auth's optional secret field covers public clients; confidential creation returns it.
          clientSecret: client.client_secret!,
        };
  } finally {
    authContext.session = null;
  }
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

/** Codemode is the only first-party OAuth execution client; app registration never grants this policy. */
export async function resolveBackofficeCodemodeExecutionPolicy(
  auth: BetterAuthInstance,
  input: { requestUrl: string; clientId: string },
): Promise<BackofficeOAuthExecutionPolicy | null> {
  const baseURL = new URL(input.requestUrl).origin;
  const { client } = await loadBackofficeCodemodeOAuth(auth, baseURL);
  const disabled = client.disabled === true || client.disabled === 1;
  return !disabled && input.clientId === client.clientId ? { kind: "first-party-user" } : null;
}
