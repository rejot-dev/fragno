import { env } from "cloudflare:workers";
import { z } from "zod";

import type { ActiveOrganization, BackofficeLink } from "../../workers/auth";

/** Where Bookkeeping may act in Backoffice: the linked organization or one approved project. */
export type BackofficeTarget =
  | { kind: "org"; orgId: string }
  | { kind: "project"; orgId: string; projectId: string };

const eventReceiptSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string().min(1),
  source: z.string().min(1),
  eventType: z.string().min(1),
  scope: z.union([
    z.object({ kind: z.literal("org"), orgId: z.string().min(1) }),
    z.object({
      kind: z.literal("project"),
      orgId: z.string().min(1),
      projectId: z.string().min(1),
    }),
  ]),
});
const resourceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization") }),
  z.object({ kind: z.literal("projects"), projectIds: z.array(z.string().min(1)).min(1) }),
]);

export type BackofficeEventReceipt = z.infer<typeof eventReceiptSchema>;

/** Every outcome the Backoffice page can act on; credentials never leave the server. */
export type ConnectionTestResult =
  | { status: "accepted"; receipt: BackofficeEventReceipt }
  | { status: "not-linked" }
  | { status: "reauthorization-required"; message: string }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "unconfirmed"; message: string };

const BACKOFFICE_UNAVAILABLE_MESSAGE = "Backoffice could not be reached. Try again shortly.";

const CONNECTION_TESTED_EVENT_TYPE = "bookkeeping.connection.tested";

function backofficeURL(path: string): string {
  return new URL(path, new URL(env.BACKOFFICE_BASE_URL).origin).toString();
}

function installCallbackURL(): string {
  return new URL("/dashboard/backoffice/callback", env.BOOKKEEPING_BASE_URL).toString();
}

function auth() {
  return env.AUTH.getByName("auth");
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = z.object({ message: z.string() }).safeParse(await response.json().catch(() => null));
  return body.success ? body.data.message : `Backoffice responded with HTTP ${response.status}.`;
}

/** The scopes the linked installation approved, in the order the page offers them. */
export function linkTargets(link: BackofficeLink): BackofficeTarget[] {
  const orgId = link.backofficeOrganizationId;
  return link.resourceScope.kind === "organization"
    ? [{ kind: "org", orgId }]
    : link.resourceScope.projectIds.map((projectId) => ({ kind: "project", orgId, projectId }));
}

export function targetKey(target: BackofficeTarget): string {
  return target.kind === "org"
    ? `org:${encodeURIComponent(target.orgId)}`
    : `project:${encodeURIComponent(target.orgId)}:${encodeURIComponent(target.projectId)}`;
}

/**
 * Bookkeeping authenticates as itself; this token never acts for a user. Returns null when
 * Backoffice is unreachable; a rejected client is a configuration error and throws.
 */
async function requestInstallationToken(): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(backofficeURL("/api/auth/oauth2/token"), {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${env.BACKOFFICE_OAUTH_CLIENT_ID}:${env.BACKOFFICE_OAUTH_CLIENT_SECRET}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "backoffice",
        resource: new URL(env.BACKOFFICE_BASE_URL).origin,
      }),
    });
  } catch {
    return null;
  }
  if (response.status >= 500) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Bookkeeping could not authenticate to Backoffice (HTTP ${response.status}). Check that its OAuth client allows client credentials.`,
    );
  }
  return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
}

/**
 * Sends the active organization's owner or admin to Backoffice to install Bookkeeping. Backoffice
 * returns them to the callback with a code and the single-use state started here.
 */
export async function startBackofficeInstall(request: Request): Promise<string | null> {
  const started = await auth().startBackofficeLink(request.headers.get("cookie") ?? "");
  if (!started) {
    return null;
  }
  const location = new URL(backofficeURL("/backoffice/apps/install"));
  location.search = new URLSearchParams({
    client_id: env.BACKOFFICE_OAUTH_CLIENT_ID,
    redirect_uri: installCallbackURL(),
    state: started.state,
  }).toString();
  return location.toString();
}

const lostAuthorityMessage =
  "You are no longer an owner or admin of this organization, so it was not connected.";

export type InstallCallbackResult =
  | { status: "linked" }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/**
 * Completes the link after Backoffice's install page. The state proves this browser session
 * started it; the code proves an organization admin approved it; Bookkeeping's client
 * credentials prove the claim comes from Bookkeeping's own server.
 */
export async function completeBackofficeInstall(
  request: Request,
  url: URL,
): Promise<InstallCallbackResult> {
  const pending = await auth().consumeBackofficeLinkRequest(
    request.headers.get("cookie") ?? "",
    url.searchParams.get("state") ?? "",
  );
  if (pending.status === "expired") {
    return { status: "failed", message: "This connection attempt expired or was already used." };
  }
  if (pending.status === "forbidden") {
    return { status: "failed", message: lostAuthorityMessage };
  }
  if (url.searchParams.get("error") === "access_denied") {
    return { status: "cancelled" };
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return { status: "failed", message: "Backoffice did not return an installation code." };
  }

  const installationToken = await requestInstallationToken();
  if (installationToken === null) {
    return { status: "failed", message: BACKOFFICE_UNAVAILABLE_MESSAGE };
  }
  const claimed = await fetch(backofficeURL("/api/backoffice/app-installations/claim"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${installationToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      code,
      externalAccount: { id: pending.organizationId, label: pending.organizationName },
    }),
  });
  if (!claimed.ok) {
    return { status: "failed", message: await readErrorMessage(claimed) };
  }
  const installation = z
    .object({ organizationId: z.string().min(1), resourceScope: resourceScopeSchema })
    .parse(await claimed.json());
  const saved = await auth().saveBackofficeLink({
    organizationId: pending.organizationId,
    backofficeOrganizationId: installation.organizationId,
    resourceScope: installation.resourceScope,
    linkedByUserId: pending.userId,
  });
  return saved ? { status: "linked" } : { status: "failed", message: lostAuthorityMessage };
}

/**
 * Sends one connection test event to an approved target, either as the organization's
 * installation or on behalf of the signed-in user. The event is sent at most once: an
 * unconfirmed delivery is reported rather than retried, so it cannot duplicate.
 */
export async function sendConnectionTestEvent(
  request: Request,
  input: {
    active: ActiveOrganization;
    link: BackofficeLink;
    actor: "organization" | "user";
    target: BackofficeTarget;
  },
): Promise<ConnectionTestResult> {
  let oauthAccessToken: string;
  if (input.actor === "organization") {
    const installationToken = await requestInstallationToken();
    if (installationToken === null) {
      return { status: "unavailable", message: BACKOFFICE_UNAVAILABLE_MESSAGE };
    }
    oauthAccessToken = installationToken;
  } else {
    const token = await auth().getBackofficeAccessToken(request.headers.get("cookie") ?? "");
    switch (token.status) {
      case "not-linked":
        return token;
      case "reauthorization-required":
        return { ...token, message: "Your Backoffice authorization has expired or was revoked." };
      case "backoffice-unavailable":
        return { status: "unavailable", message: BACKOFFICE_UNAVAILABLE_MESSAGE };
      case "linked":
        oauthAccessToken = token.accessToken;
    }
  }

  let exchanged: Response;
  try {
    exchanged = await fetch(backofficeURL("/api/backoffice/execution-token"), {
      method: "POST",
      headers: { authorization: `Bearer ${oauthAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: input.target }),
    });
  } catch {
    return { status: "unavailable", message: BACKOFFICE_UNAVAILABLE_MESSAGE };
  }
  if (exchanged.status >= 500) {
    return { status: "unavailable", message: BACKOFFICE_UNAVAILABLE_MESSAGE };
  }
  if (exchanged.status === 401) {
    return { status: "reauthorization-required", message: await readErrorMessage(exchanged) };
  }
  if (exchanged.status === 403) {
    return { status: "rejected", message: await readErrorMessage(exchanged) };
  }
  if (!exchanged.ok) {
    throw new Error(`Backoffice credential exchange failed with HTTP ${exchanged.status}.`);
  }
  const { accessToken } = z
    .object({ accessToken: z.string().min(1) })
    .parse(await exchanged.json());

  let delivered: Response;
  try {
    delivered = await fetch(
      backofficeURL(`/api/backoffice/scopes/${targetKey(input.target)}/events`),
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          eventType: CONNECTION_TESTED_EVENT_TYPE,
          payload: {
            message: `Hello from ${input.active.organization.name}`,
            sentAs: input.actor,
            sentAt: new Date().toISOString(),
          },
        }),
      },
    );
  } catch {
    return { status: "unconfirmed", message: "Backoffice could not be reached." };
  }
  if (delivered.status === 202) {
    return { status: "accepted", receipt: eventReceiptSchema.parse(await delivered.json()) };
  }
  if (delivered.status === 403 || delivered.status === 404) {
    return { status: "rejected", message: await readErrorMessage(delivered) };
  }
  return {
    status: "unconfirmed",
    message: `Backoffice responded with HTTP ${delivered.status}; the event may not have been recorded.`,
  };
}
