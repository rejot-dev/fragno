import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";

import { Cursor, decodeCursor } from "@fragno-dev/db";

import {
  DEVICE_CODE_GRANT_TYPE,
  oauthDeviceAuthorization,
  oauthProvider,
  type OAuthClientAdministrativeResponse,
} from "@better-auth/oauth-provider";

import type { BackofficeCliOAuthConfig } from "@/fragno/auth/contracts";
import {
  BACKOFFICE_CLIENT_CREDENTIALS_SCOPES,
  BACKOFFICE_OAUTH_SCOPES,
  backofficeOAuthClientGrantTypes,
  type BackofficeOAuthClientCreateInput,
  type BackofficeOAuthClientCreateResult,
  type BackofficeOAuthClientFacts,
  type BackofficeOAuthClientRotateSecretInput,
  type BackofficeOAuthClientRotateSecretResult,
  type BackofficeOAuthClientUpdateInput,
  type BackofficeOAuthClientUpdateResult,
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
    client_credentials_scopes?: string[];
  };
}) => Promise<OAuthClientAdministrativeResponse>;
type StoreOAuthClient = {
  clientId: string;
  softwareId: string | null;
  referenceId: string | null;
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

/**
 * Better Auth intersects requested scopes with the resource's allowed scopes. Allowing every
 * Backoffice scope keeps identity claims available to apps that also request execution access.
 */
async function ensureBackofficeOAuthResource(
  adapter: BetterAuthAdapter,
  baseURL: string,
): Promise<void> {
  const existingResource = await adapter.findOne<StoreOAuthResource>({
    model: "oauthResource",
    where: [{ field: "identifier", value: baseURL }],
  });
  if (existingResource) {
    const allowedScopes = existingResource.allowedScopes ?? [];
    if (!BACKOFFICE_OAUTH_SCOPES.every((scope) => allowedScopes.includes(scope))) {
      await adapter.update<StoreOAuthResource>({
        model: "oauthResource",
        where: [{ field: "id", value: existingResource.id }],
        update: { allowedScopes: [...BACKOFFICE_OAUTH_SCOPES], updatedAt: new Date() },
      });
    }
    return;
  }
  await adapter.create<StoreOAuthResource>({
    model: "oauthResource",
    data: {
      identifier: baseURL,
      name: "Fragno Backoffice",
      allowedScopes: [...BACKOFFICE_OAUTH_SCOPES],
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

/**
 * Runs a session-gated Better Auth endpoint as the given administrator. Callers must use an
 * isolated Auth instance so synthetic server session state cannot leak to HTTP requests.
 */
async function runAsAdministrator<T>(
  auth: BetterAuthInstance,
  administratorUserId: string,
  run: () => Promise<T>,
): Promise<T> {
  const authContext = await getAuthContext(auth);
  const user = await authContext.internalAdapter.findUserById(administratorUserId);
  if (!user) {
    throw new Error("Admin OAuth client management requires an existing administrator user.");
  }
  const now = new Date();
  authContext.session = {
    user,
    session: {
      id: "backoffice-admin-oauth-client-management",
      token: "backoffice-admin-oauth-client-management",
      userId: user.id,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
  };
  try {
    return await run();
  } finally {
    authContext.session = null;
  }
}

/**
 * Better Auth reports ownership failures as a bare UNAUTHORIZED error without a message. Name the
 * actual rule so administrators know whose client it is and what to do.
 */
async function describeOAuthClientManagementErrors<T>(
  auth: BetterAuthInstance,
  clientId: string,
  run: () => Promise<T>,
): Promise<T> {
  const client = await getBackofficeOAuthClientFacts(auth, clientId);
  if (!client) {
    throw new Error(
      `OAuth client '${clientId}' was not found. List clients with admin.oauth-clients.list.`,
    );
  }
  if (client.managedByBackoffice) {
    throw new Error(
      `OAuth client '${clientId}' is the deployment's Codemode client. Backoffice manages it, so it cannot be changed. Use a client created with admin.oauth-clients.create.`,
    );
  }
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof APIError)) {
      throw error;
    }
    if (error.status === "UNAUTHORIZED") {
      throw new Error(
        `Only the administrator who owns OAuth client '${clientId}' can change it. Check its owner with admin.oauth-clients.list, or create a new client.`,
        { cause: error },
      );
    }
    if (error.status === "NOT_FOUND") {
      throw new Error(`OAuth client '${clientId}' was not found.`, { cause: error });
    }
    const description = (error.body as { error_description?: unknown } | undefined)
      ?.error_description;
    throw new Error(
      typeof description === "string" && description
        ? `OAuth client '${clientId}' could not be changed: ${description}.`
        : `OAuth client '${clientId}' could not be changed (${error.status}).`,
      { cause: error },
    );
  }
}

type AdminUpdateOAuthClientEndpoint = (input: {
  headers: Headers;
  body: {
    client_id: string;
    update: {
      redirect_uris: string[];
      scope: string;
      grant_types: string[];
      client_credentials_scopes: string[];
    };
  };
}) => Promise<OAuthClientAdministrativeResponse & { client_credentials_scopes: string[] }>;
type RotateOAuthClientSecretEndpoint = (input: {
  headers: Headers;
  body: { client_id: string };
}) => Promise<OAuthClientAdministrativeResponse>;

export async function createBackofficeAdminOAuthClient(
  auth: BetterAuthInstance,
  input: BackofficeOAuthClientCreateInput & { administratorUserId: string },
): Promise<BackofficeOAuthClientCreateResult> {
  const createClient = getAdminCreateOAuthClientEndpoint(auth);
  const client = await runAsAdministrator(auth, input.administratorUserId, async () =>
    createClient({
      headers: new Headers(),
      body: {
        client_name: input.name,
        redirect_uris: input.redirectUris,
        scope: input.scopes.join(" "),
        token_endpoint_auth_method: input.clientType === "public" ? "none" : "client_secret_basic",
        application_type: input.applicationType,
        require_pkce: true,
        grant_types: backofficeOAuthClientGrantTypes(input),
        ...(input.clientCredentials
          ? { client_credentials_scopes: [...BACKOFFICE_CLIENT_CREDENTIALS_SCOPES] }
          : {}),
      },
    }),
  );
  return input.clientType === "public"
    ? { clientType: "public", clientId: client.client_id, clientSecret: null }
    : {
        clientType: "confidential",
        clientId: client.client_id,
        // Better Auth's optional secret field covers public clients; confidential creation returns it.
        clientSecret: client.client_secret!,
      };
}

/** Better Auth permits only the owning administrator to change a client's settings. */
export async function updateBackofficeAdminOAuthClient(
  auth: BetterAuthInstance,
  input: BackofficeOAuthClientUpdateInput & { administratorUserId: string },
): Promise<BackofficeOAuthClientUpdateResult> {
  // Plugin endpoints are erased from runtime-factory options; assert at the plugin boundary.
  const { adminUpdateOAuthClient } = (
    auth as unknown as { api: { adminUpdateOAuthClient: AdminUpdateOAuthClientEndpoint } }
  ).api;
  const client = await runAsAdministrator(auth, input.administratorUserId, async () =>
    describeOAuthClientManagementErrors(auth, input.clientId, async () =>
      adminUpdateOAuthClient({
        headers: new Headers(),
        body: {
          client_id: input.clientId,
          update: {
            redirect_uris: input.redirectUris,
            scope: input.scopes.join(" "),
            grant_types: backofficeOAuthClientGrantTypes(input),
            client_credentials_scopes: input.clientCredentials
              ? [...BACKOFFICE_CLIENT_CREDENTIALS_SCOPES]
              : [],
          },
        },
      }),
    ),
  );
  return {
    clientId: client.client_id,
    redirectUris: client.redirect_uris ?? [],
    scopes: client.scope?.split(" ") ?? [],
    clientCredentials: client.client_credentials_scopes.length > 0,
  };
}

/** Rotation is limited to the owning administrator; the previous secret stops working at once. */
export async function rotateBackofficeAdminOAuthClientSecret(
  auth: BetterAuthInstance,
  input: BackofficeOAuthClientRotateSecretInput & { administratorUserId: string },
): Promise<BackofficeOAuthClientRotateSecretResult> {
  const { rotateClientSecret } = (
    auth as unknown as { api: { rotateClientSecret: RotateOAuthClientSecretEndpoint } }
  ).api;
  const client = await runAsAdministrator(auth, input.administratorUserId, async () =>
    describeOAuthClientManagementErrors(auth, input.clientId, async () =>
      rotateClientSecret({ headers: new Headers(), body: { client_id: input.clientId } }),
    ),
  );
  if (!client.client_secret) {
    throw new Error("OAuth client secret rotation did not return a secret.");
  }
  return { clientId: client.client_id, clientSecret: client.client_secret };
}

/** Reads credential-free client facts; app registration and installation flows validate these. */
export async function getBackofficeOAuthClientFacts(
  auth: BetterAuthInstance,
  clientId: string,
): Promise<BackofficeOAuthClientFacts | null> {
  const client = await (
    await getAuthContext(auth)
  ).adapter.findOne<StoreOAuthClient & { redirectUris: string[] | null }>({
    model: "oauthClient",
    select: ["clientId", "referenceId", "name", "scopes", "disabled", "redirectUris"],
    where: [{ field: "clientId", value: clientId }],
  });
  return client
    ? {
        clientId: client.clientId,
        name: client.name,
        redirectUris: client.redirectUris ?? [],
        scopes: client.scopes ?? [],
        disabled: isOAuthClientDisabled(client),
        // Only the server bootstrap assigns this reference owner; managed clients cannot claim it.
        managedByBackoffice: client.referenceId === BACKOFFICE_CODEMODE_OAUTH_SOFTWARE_ID,
      }
    : null;
}

export async function initializeBackofficeCodemodeOAuthClient(
  auth: BetterAuthInstance,
): Promise<void> {
  const authContext = await getAuthContext(auth);
  await ensureBackofficeCodemodeOAuthClient(authContext, getAdminCreateOAuthClientEndpoint(auth));
}

/** Each served origin is its own OAuth resource, so apps can target it before Codemode is used. */
export async function initializeBackofficeOAuthResource(
  auth: BetterAuthInstance,
  baseURL: string,
): Promise<void> {
  await ensureBackofficeOAuthResource((await getAuthContext(auth)).adapter, baseURL);
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

/**
 * Codemode is the only first-party OAuth execution client. Any other enabled client can only
 * receive app-bound authority, and only once it is registered as a Backoffice app.
 */
export async function resolveBackofficeOAuthExecutionPolicy(
  auth: BetterAuthInstance,
  input: {
    requestUrl: string;
    clientId: string;
    findAppIdByOAuthClientId(clientId: string): Promise<string | null>;
  },
): Promise<BackofficeOAuthExecutionPolicy | null> {
  const baseURL = new URL(input.requestUrl).origin;
  const { authContext, client: codemodeClient } = await loadBackofficeCodemodeOAuth(auth, baseURL);
  if (input.clientId === codemodeClient.clientId) {
    return isOAuthClientDisabled(codemodeClient) ? null : { kind: "first-party-user" };
  }
  const client = await authContext.adapter.findOne<StoreOAuthClient>({
    model: "oauthClient",
    where: [{ field: "clientId", value: input.clientId }],
  });
  if (!client || isOAuthClientDisabled(client)) {
    return null;
  }
  const appId = await input.findAppIdByOAuthClientId(input.clientId);
  return appId === null ? null : { kind: "installed-app", appId };
}

function isOAuthClientDisabled(client: StoreOAuthClient): boolean {
  return client.disabled === true || client.disabled === 1;
}
