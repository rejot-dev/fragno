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
import { exchangeForScope, isBackofficeUnavailable } from "../../workers/backoffice/client";
import { followManager } from "../../workers/backoffice/management";
import type {
  MembershipThrough,
  Organization,
  OrganizationKind,
} from "../../workers/directory/directory";
import {
  MEMBERSHIP_CONFIRMATION_LIFETIME_MS,
  membershipThrough,
} from "../../workers/directory/membership";
import { currentPath, requireSessionUser } from "../auth/session.server";

/** The signed-in person in one of their organizations, or a client of their firm. */
export type OrganizationContext = {
  user: SessionUser;
  organization: Organization;
  roles: OrganizationRole[];
  through: MembershipThrough;
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
 * The person's membership as Backoffice confirms it now, with the organization as Backoffice names
 * it, the organization managing it, and whether they reach it through its firm; null when
 * Backoffice refuses them, because they were removed or Bookkeeping was uninstalled.
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
    managingOrganizationId: confirmed.managingOrganization?.organizationId ?? null,
    roles: parseRoles(confirmed.roles),
    through: membershipThrough(confirmed.through),
    confirmedAt: Date.now(),
  };
}

/**
 * Asks Backoffice, as the signed-in person, which firm manages the client, e.g. one its firm's
 * dashboard finds the firm newly manages. Does nothing when Backoffice refuses them.
 */
export async function confirmManager(request: Request, clientId: string): Promise<void> {
  const client = await directory().findClient(clientId);
  if (client === null) {
    return;
  }
  const confirmed = await confirmWithBackoffice(request, clientId);
  if (confirmed) {
    await followManager(env, {
      clientId,
      expectedFirmId: client.firmId,
      managingOrganizationId: confirmed.managingOrganizationId,
    });
  }
}

/**
 * The signed-in person in the organization at `slug`, which must be of `kind`: one of its members,
 * or, in a client, a member of its firm. A membership Backoffice confirmed within the last minute is
 * trusted; otherwise Backoffice confirms it again, with their current roles, or Bookkeeping forgets
 * it: they were removed, or Bookkeeping was uninstalled.
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
    return { user, organization, roles: known.roles, through: known.through };
  }
  const confirmed = await confirmWithBackoffice(request, organization.id);
  if (!confirmed) {
    await directory().removeMembership({
      organizationId: organization.id,
      userId: user.backofficeUserId,
    });
    throw organizationNotFound();
  }
  const { managingOrganizationId, ...membership } = confirmed;
  await directory().confirmMembership({ ...membership, userId: user.backofficeUserId });
  const named = { ...organization, ...confirmed.organization };
  return {
    user,
    // A Backoffice administrator may end a client's management, or move it to another firm.
    organization:
      named.kind === "client"
        ? {
            ...named,
            // Recorded before asking Backoffice, so an answer arriving after a newer one changes
            // nothing.
            firmId: await followManager(env, {
              clientId: named.id,
              expectedFirmId: organization.kind === "client" ? organization.firmId : null,
              managingOrganizationId,
            }),
          }
        : named,
    roles: confirmed.roles,
    through: confirmed.through,
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
    return { user, organization: operators, roles: known.roles, through: known.through };
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
  const { managingOrganizationId: _, ...membership } = confirmed;
  await directory().confirmOperator({ ...membership, userId: user.backofficeUserId });
  return {
    user,
    organization: { ...confirmed.organization, kind: "operator" },
    roles: confirmed.roles,
    through: confirmed.through,
  };
}
