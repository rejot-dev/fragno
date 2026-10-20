import {
  BackofficeApiRequestError,
  BackofficeApiUnreachableError,
  type BackofficeApiClient,
} from "@fragno-dev/backoffice-api/v0/client";
import { organizationRoleSchema } from "@fragno-dev/backoffice-api/v0/organization";
import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import type { SessionUser } from "../../workers/auth";
import { exchangeForOrganization, isBackofficeUnavailable } from "../../workers/backoffice-client";
import type { Workspace, WorkspaceMembership, WorkspaceRole } from "../../workers/workspaces";
import { requireSessionUser } from "./session.server";

/**
 * How long Bookkeeping trusts a membership Backoffice confirmed. Someone removed in Backoffice
 * keeps access at most this long.
 */
const CONFIRMATION_LIFETIME_MS = 60_000;

export type WorkspaceContext = { user: SessionUser; membership: WorkspaceMembership };

function workspaces() {
  return env.WORKSPACES.getByName("workspaces");
}

export function backofficeUnavailable(): Response {
  return new Response("Backoffice could not be reached. Try again shortly.", { status: 503 });
}

function workspaceNotFound(): Response {
  return new Response("This workspace does not exist, or you are not a member.", { status: 404 });
}

export function parseRoles(roles: string[]): WorkspaceRole[] {
  return organizationRoleSchema.array().min(1).parse(roles);
}

export function canInvite(roles: WorkspaceRole[]): boolean {
  return roles.includes("owner") || roles.includes("admin");
}

/** Runs Backoffice calls; Backoffice being down becomes a 503 page. */
export async function callBackoffice<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof BackofficeApiUnreachableError || isBackofficeUnavailable(error)) {
      throw backofficeUnavailable();
    }
    if (error instanceof BackofficeApiRequestError && error.code === null) {
      throw backofficeUnavailable();
    }
    throw error;
  }
}

/**
 * Backoffice's API as the signed-in person, in one workspace. Backoffice checks again that they
 * are a member; null means it refused.
 */
export async function connectAsUser(
  request: Request,
  workspace: Workspace,
): Promise<BackofficeApiClient | null> {
  const token = await env.AUTH.getByName("auth").getBackofficeAccessToken(
    request.headers.get("cookie") ?? "",
  );
  switch (token.status) {
    case "backoffice-unavailable":
      throw backofficeUnavailable();
    // Signing in again renews the authorization.
    case "reauthorization-required":
      throw redirect("/login");
    case "authorized":
      break;
  }
  const credential = await callBackoffice(() =>
    exchangeForOrganization(env, {
      oauthAccessToken: token.accessToken,
      organizationId: workspace.id,
    }),
  );
  if (credential.status === "unauthorized") {
    throw redirect("/login");
  }
  return credential.status === "issued" ? credential.client : null;
}

/**
 * The signed-in person's membership in the workspace at `slug`. A membership Backoffice confirmed
 * within the last minute is trusted; otherwise Backoffice confirms it again, with the person's
 * current roles, or Bookkeeping forgets it: they were removed, or Bookkeeping was uninstalled.
 */
export async function requireWorkspace(request: Request, slug: string): Promise<WorkspaceContext> {
  const user = await requireSessionUser(request);
  const known = await workspaces().findMembership({ slug, userId: user.backofficeUserId });
  if (known && Date.now() - known.confirmedAt < CONFIRMATION_LIFETIME_MS) {
    return { user, membership: known };
  }
  const workspace = known?.workspace ?? (await workspaces().findWorkspace(slug));
  if (!workspace) {
    throw workspaceNotFound();
  }
  const backoffice = await connectAsUser(request, workspace);
  if (!backoffice) {
    await workspaces().removeMembership({
      workspaceId: workspace.id,
      userId: user.backofficeUserId,
    });
    throw workspaceNotFound();
  }
  const { organization, roles } = await callBackoffice(() =>
    backoffice.call({ kind: "org", orgId: workspace.id }, "org.get"),
  );
  const membership: WorkspaceMembership = {
    workspace: {
      id: organization.organizationId,
      slug: organization.slug,
      name: organization.name,
    },
    roles: parseRoles(roles),
    confirmedAt: Date.now(),
  };
  await workspaces().recordMembership({
    workspace: membership.workspace,
    member: {
      userId: user.backofficeUserId,
      name: user.name,
      email: user.email,
      roles: membership.roles,
    },
    confirmedAt: membership.confirmedAt,
  });
  return { user, membership };
}
