import {
  BackofficeApiRequestError,
  BackofficeApiUnreachableError,
  type BackofficeApiClient,
} from "@fragno-dev/backoffice-api/v0/client";
import {
  organizationRoleSchema,
  type OrganizationRole,
} from "@fragno-dev/backoffice-api/v0/organization";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { env } from "cloudflare:workers";
import { redirect } from "react-router";

import type { SessionUser } from "../../workers/auth/auth";
import {
  exchangeForScope,
  isBackofficeUnavailable,
  requestAppToken,
} from "../../workers/backoffice/client";
import type { Organization, OrganizationKind } from "../../workers/directory/directory";
import { MEMBERSHIP_CONFIRMATION_LIFETIME_MS } from "../../workers/directory/membership";
import { currentPath, requireSessionUser } from "../auth/session.server";

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
 * Backoffice's API as the signed-in person, in one scope: an organization, or one of its projects.
 * Backoffice checks again that they are a member; null means it refused.
 */
export async function connectAsUser(
  request: Request,
  scope: BackofficeContextScope,
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
    exchangeForScope(env, { oauthAccessToken: token.accessToken, scope }),
  );
  if (credential.status === "unauthorized") {
    throw reauthorize(request);
  }
  return credential.status === "issued" ? credential.client : null;
}

/**
 * Backoffice's API as Bookkeeping's installation, in one scope, so what it starts, such as an
 * agent's turn, acts as Bookkeeping and not as a person; null when Bookkeeping is not installed
 * there. Throws `BackofficeUnavailableError` when Backoffice cannot be reached.
 */
export async function connectAsInstallation(
  scope: BackofficeContextScope,
): Promise<BackofficeApiClient | null> {
  const credential = await exchangeForScope(env, {
    oauthAccessToken: await requestAppToken(env),
    scope,
  });
  if (credential.status === "unauthorized") {
    throw new Error("Backoffice refused Bookkeeping's own token. Check its OAuth client.");
  }
  return credential.status === "issued" ? credential.client : null;
}

/**
 * The person's membership as Backoffice confirms it now, with the organization as Backoffice names
 * it; null when Backoffice refuses them, because they were removed or Bookkeeping was uninstalled.
 */
async function confirmWithBackoffice(request: Request, organizationId: string) {
  const backoffice = await connectAsUser(request, {
    kind: "org",
    orgId: organizationId,
    jurisdiction: null,
  });
  if (!backoffice) {
    return null;
  }
  const confirmed = await callBackoffice(() =>
    backoffice.call({ kind: "org", orgId: organizationId, jurisdiction: null }, "org.get"),
  );
  return {
    organization: {
      id: confirmed.organization.organizationId,
      slug: confirmed.organization.slug,
      name: confirmed.organization.name,
    },
    roles: parseRoles(confirmed.roles),
    confirmedAt: Date.now(),
  };
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
  kind: Exclude<OrganizationKind, "operator">,
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
  if (known && Date.now() - known.confirmedAt < MEMBERSHIP_CONFIRMATION_LIFETIME_MS) {
    return { user, organization, roles: known.roles };
  }
  const confirmed = await confirmWithBackoffice(request, organization.id);
  if (!confirmed) {
    await directory().removeMembership({
      organizationId: organization.id,
      userId: user.backofficeUserId,
    });
    throw organizationNotFound();
  }
  await directory().confirmMembership({ ...confirmed, userId: user.backofficeUserId });
  return {
    user,
    organization: { ...organization, ...confirmed.organization },
    roles: confirmed.roles,
  };
}

/**
 * The signed-in person as an operator: a member of the operator organization, which Backoffice's
 * administrator created for Bookkeeping. Membership is confirmed as for any organization; to
 * anyone else, the operator's pages do not exist.
 */
export async function requireOperator(request: Request): Promise<OrganizationContext> {
  const user = await requireSessionUser(request);
  const operatorsId = env.BOOKKEEPING_OPERATOR_ORGANIZATION_ID;
  if (operatorsId === "") {
    throw organizationNotFound();
  }
  const operators = await directory().findOperators(operatorsId);
  const known =
    operators &&
    (await directory().findMembership({
      organizationId: operators.id,
      userId: user.backofficeUserId,
    }));
  if (operators && known && Date.now() - known.confirmedAt < MEMBERSHIP_CONFIRMATION_LIFETIME_MS) {
    return { user, organization: operators, roles: known.roles };
  }
  const confirmed = await confirmWithBackoffice(request, operatorsId);
  if (!confirmed) {
    if (operators) {
      await directory().removeMembership({
        organizationId: operators.id,
        userId: user.backofficeUserId,
      });
    }
    throw organizationNotFound();
  }
  await directory().confirmOperator({ ...confirmed, userId: user.backofficeUserId });
  return {
    user,
    organization: { ...confirmed.organization, kind: "operator" },
    roles: confirmed.roles,
  };
}
