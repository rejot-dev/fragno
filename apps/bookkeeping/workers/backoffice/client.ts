import {
  createBackofficeApiClient,
  createBackofficeProvisioningClient,
  type BackofficeApiClient,
  type BackofficeProvisioningClient,
} from "@fragno-dev/backoffice-api/v0/client";
import { z } from "zod";

type BackofficeEnv = Pick<
  CloudflareEnv,
  "BACKOFFICE_BASE_URL" | "BACKOFFICE_OAUTH_CLIENT_ID" | "BACKOFFICE_OAUTH_CLIENT_SECRET"
>;

/** Backoffice could not be reached or failed, so what was asked of it may not have happened. */
export class BackofficeUnavailableError extends Error {
  override readonly name = "BackofficeUnavailableError";

  constructor(cause?: unknown) {
    super("Backoffice could not be reached. Try again shortly.", { cause });
  }
}

/** Whether an error, possibly one that crossed Durable Object RPC, is Backoffice being down. */
export function isBackofficeUnavailable(error: unknown): error is Error {
  return error instanceof Error && error.name === "BackofficeUnavailableError";
}

export function backofficeOrigin(env: BackofficeEnv): string {
  return new URL(env.BACKOFFICE_BASE_URL).origin;
}

async function post(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, method: "POST" });
  } catch (error) {
    throw new BackofficeUnavailableError(error);
  }
  if (response.status >= 500) {
    throw new BackofficeUnavailableError(`HTTP ${response.status}`);
  }
  return response;
}

/** Bookkeeping's own token, which never acts for a user. A rejected client is misconfiguration. */
export async function requestAppToken(env: BackofficeEnv): Promise<string> {
  const response = await post(`${backofficeOrigin(env)}/api/auth/oauth2/token`, {
    headers: {
      authorization: `Basic ${btoa(`${env.BACKOFFICE_OAUTH_CLIENT_ID}:${env.BACKOFFICE_OAUTH_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "backoffice",
      resource: backofficeOrigin(env),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Bookkeeping could not authenticate to Backoffice (HTTP ${response.status}). Check that its OAuth client allows client credentials.`,
    );
  }
  return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
}

export async function createProvisioningClient(
  env: BackofficeEnv,
): Promise<BackofficeProvisioningClient> {
  return createBackofficeProvisioningClient({
    origin: backofficeOrigin(env),
    accessToken: await requestAppToken(env),
    fetch,
  });
}

/**
 * What Backoffice answers when asked for a credential in one organization: `refused` when
 * Bookkeeping is not installed there or a user is no longer a member, and `unauthorized` when the
 * OAuth token itself is no longer valid.
 */
export type OrganizationCredential =
  | { status: "issued"; client: BackofficeApiClient }
  | { status: "refused" }
  | { status: "unauthorized" };

export async function exchangeForOrganization(
  env: BackofficeEnv,
  input: { oauthAccessToken: string; organizationId: string },
): Promise<OrganizationCredential> {
  const response = await post(`${backofficeOrigin(env)}/api/backoffice/execution-token`, {
    headers: {
      authorization: `Bearer ${input.oauthAccessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope: { kind: "org", orgId: input.organizationId } }),
  });
  if (response.status === 401) {
    return { status: "unauthorized" };
  }
  if (response.status === 403) {
    return { status: "refused" };
  }
  if (!response.ok) {
    throw new Error(`Backoffice credential exchange failed with HTTP ${response.status}.`);
  }
  const { accessToken } = z.object({ accessToken: z.string().min(1) }).parse(await response.json());
  return {
    status: "issued",
    client: createBackofficeApiClient({ origin: backofficeOrigin(env), accessToken, fetch }),
  };
}
