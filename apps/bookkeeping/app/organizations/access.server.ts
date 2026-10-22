import {
  BackofficeApiRequestError,
  BackofficeApiUnreachableError,
  type BackofficeApiClient,
} from "@fragno-dev/backoffice-api/v0/client";
import {
  organizationRoleSchema,
  type OrganizationRole,
} from "@fragno-dev/backoffice-api/v0/organization";
import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import type { SessionUser } from "../../workers/auth/auth";
import { exchangeForOrganization, isBackofficeUnavailable } from "../../workers/backoffice/client";
import type { Organization, OrganizationKind } from "../../workers/directory/directory";
import { currentPath, requireSessionUser } from "../auth/session.server";

/**
 * How long Bookkeeping trusts a membership Backoffice confirmed. Someone removed in Backoffice
 * keeps access at most this long.
 */
const CONFIRMATION_LIFETIME_MS = 60_000;

/** The signed-in person in one of their organizations. */
export type OrganizationContext = {
  user: SessionUser;
  organization: Organization;
  roles: OrganizationRole[];
};

function directory() {
  return env.DIRECTORY.getByName("directory");
}

export function backofficeUnavailable(): Response {
  return new Response("Backoffice could not be reached. Try again shortly.", { status: 503 });
}

export function organizationNotFound(): Response {
  return new Response("This page does not exist, or you are not a member.", { status: 404 });
}

export function parseRoles(roles: string[]): OrganizationRole[] {
  return organizationRoleSchema.array().min(1).parse(roles);
}

/** Owners and admins invite people and create administrations. */
export function canManage(roles: OrganizationRole[]): boolean {
  return roles.includes("owner") || roles.includes("admin");
}

/** Whether what was asked of Backoffice may or may not have happened. */
export function isOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof BackofficeApiUnreachableError ||
    isBackofficeUnavailable(error) ||
    (error instanceof BackofficeApiRequestError && error.code === null)
  );
}

/** Runs Backoffice calls; an unknown outcome becomes a 503 page. */
export async function callBackoffice<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isOutcomeUnknown(error)) {
      throw backofficeUnavailable();
    }
    throw error;
  }
}

/** Signing in again renews a revoked or expired Backoffice authorization. */
function reauthorize(request: Request): Response {
  return redirect(`/login?reauthorize=1&returnTo=${encodeURIComponent(currentPath(request))}`);
}

/**
 * Backoffice's API as the signed-in person, in one organization. Backoffice checks again that they
 * are a member; null means it refused.
 */
export async function connectAsUser(
  request: Request,
  organizationId: string,
): Promise<BackofficeApiClient | null> {
  const token = await env.AUTH.getByName("auth").getBackofficeAccessToken(
    request.headers.get("cookie") ?? "",
  );
  switch (token.status) {
    case "backoffice-unavailable":
      throw backofficeUnavailable();
    case "reauthorization-required":
      throw reauthorize(request);
    case "authorized":
      break;
  }
  const credential = await callBackoffice(() =>
    exchangeForOrganization(env, { oauthAccessToken: token.accessToken, organizationId }),
  );
  if (credential.status === "unauthorized") {
    throw reauthorize(request);
  }
  return credential.status === "issued" ? credential.client : null;
}

/**
 * The signed-in person in the organization at `slug`, which must be of `kind`. A membership
 * Backoffice confirmed within the last minute is trusted; otherwise Backoffice confirms it again,
 * with their current roles, or Bookkeeping forgets it: they were removed, or Bookkeeping was
 * uninstalled.
 */
export async function requireOrganization(
  request: Request,
  slug: string,
  kind: OrganizationKind,
): Promise<OrganizationContext> {
  const user = await requireSessionUser(request);
  const organization = await directory().findOrganization(slug);
  if (organization?.kind !== kind) {
    throw organizationNotFound();
  }
  const known = await directory().findMembership({
    organizationId: organization.id,
    userId: user.backofficeUserId,
  });
  if (known && Date.now() - known.confirmedAt < CONFIRMATION_LIFETIME_MS) {
    return { user, organization, roles: known.roles };
  }
  const backoffice = await connectAsUser(request, organization.id);
  if (!backoffice) {
    await directory().removeMembership({
      organizationId: organization.id,
      userId: user.backofficeUserId,
    });
    throw organizationNotFound();
  }
  const confirmed = await callBackoffice(() =>
    backoffice.call({ kind: "org", orgId: organization.id }, "org.get"),
  );
  const roles = parseRoles(confirmed.roles);
  const current = {
    id: confirmed.organization.organizationId,
    slug: confirmed.organization.slug,
    name: confirmed.organization.name,
  };
  await directory().confirmMembership({
    organization: current,
    userId: user.backofficeUserId,
    roles,
    confirmedAt: Date.now(),
  });
  return { user, organization: { ...organization, ...current }, roles };
}
