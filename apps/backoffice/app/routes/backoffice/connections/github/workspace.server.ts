import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { GitHubInstallationOwner } from "@/fragno/github";

/**
 * How page URLs name a workspace GitHub installations belong to, with its name, or null for an
 * organization the user is not a member of. A personal workspace is named by its user, and its
 * pages decide who may enter it.
 */
export function gitHubWorkspace(
  me: BackofficeMeData,
  owner: GitHubInstallationOwner,
): { routeScope: BackofficeRouteScope; label: string } | null {
  if (owner.kind === "user") {
    return {
      routeScope: { kind: "user", userId: owner.userId },
      label: owner.userId === me.user.id ? "your personal workspace" : "a personal workspace",
    };
  }
  const organization = me.organizations.find(
    (entry) => entry.organization.id === owner.orgId,
  )?.organization;
  return organization
    ? { routeScope: { kind: "org", orgSlug: organization.slug }, label: organization.name }
    : null;
}
