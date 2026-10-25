import { backofficeScopeRootOwner } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";

const SCOPE_ROUTE_KINDS = new Set(["system", "org", "project", "user"]);

const MARKETPLACE_TABS = new Set(["marketplace", "installed", "my-listings"]);

// Every organization has these tabs, so they carry over; the others depend on how the user acts in
// the organization or what it manages.
const ORGANIZATION_SETTINGS_TABS = new Set(["members", "billing"]);

/**
 * Owner switches keep settings open: an organization's settings in its workspace, and the
 * user's own settings in their personal workspace. Another person's workspace has none. An
 * organization's billing and the user's usage are the same statement for each owner, so either
 * opens the other.
 */
function settingsPath(
  scope: BackofficeRouteScope,
  organizationTab: string | null,
  viewerUserId: string | null,
): string | null {
  const owner = backofficeScopeRootOwner(scope);
  if (owner?.kind === "org") {
    const tab = organizationTab ? `/${organizationTab}` : "";
    return `/backoffice/organizations/${encodeURIComponent(owner.orgSlug)}${tab}`;
  }
  if (owner?.kind === "user" && owner.userId === viewerUserId) {
    return organizationTab === "billing" ? "/backoffice/usage" : "/backoffice/settings";
  }
  return null;
}

// Rebuilds the current URL for another scope: keeps the active section, keeps
// the section tab where scope-independent, and otherwise lands on the scoped
// index (which redirects to the section default).
/**
 * Builds a browser route without accepting runtime organization identity. `viewerUserId` tells the
 * user's own personal workspace from a member's, whose settings are not theirs to open.
 */
export const scopeSwitchPath = (
  pathname: string,
  scope: BackofficeRouteScope,
  viewerUserId: string | null = null,
) => {
  const scopePath = backofficeRouteScopePath(scope);
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[1];
  const scoped = segments.length >= 4 && SCOPE_ROUTE_KINDS.has(segments[2] ?? "");
  const rest = scoped ? segments.slice(4) : segments.slice(2);

  switch (section) {
    case "dashboard":
      return `/backoffice/dashboard/${scopePath}`;
    // A selected computer belongs to its scope, so switching lands on the scope's list. The
    // system scope has no computers; its index explains that instead of opening a kind.
    case "computers":
      return scope.kind === "system"
        ? `/backoffice/computers/${scopePath}`
        : `/backoffice/computers/${scopePath}/sandboxes`;
    case "agents":
      return `/backoffice/agents/${scopePath}/agents`;
    case "files":
      return `/backoffice/files/${scopePath}`;
    // Connection addresses resolve only in their own scope, so a selection does not carry over.
    case "integrations":
      return `/backoffice/integrations/${scopePath}`;
    case "marketplace": {
      const tab = rest[0] && MARKETPLACE_TABS.has(rest[0]) ? rest[0] : "marketplace";
      return `/backoffice/marketplace/${scopePath}/${tab}`;
    }
    // The user's settings, organizations list, and usage, and an organization's settings pages.
    case "settings":
    case "organizations":
    case "usage": {
      // Settings URLs cannot encode a project or app; selecting one must enter its workspace.
      if (scope.kind === "project" || scope.kind === "app") {
        return `/backoffice/dashboard/${scopePath}`;
      }
      const organizationTab =
        section === "usage"
          ? "billing"
          : section === "organizations" && rest[1] && ORGANIZATION_SETTINGS_TABS.has(rest[1])
            ? rest[1]
            : null;
      return (
        settingsPath(scope, organizationTab, viewerUserId) ?? `/backoffice/dashboard/${scopePath}`
      );
    }
    case "internals": {
      const internalTool = rest[0];
      if (internalTool === "durable-hooks") {
        const objectId = rest[1];
        const objectPath = objectId ? `/${encodeURIComponent(objectId)}` : "";
        return `/backoffice/internals/${scopePath}/durable-hooks${objectPath}`;
      }
      if (internalTool === "workflows") {
        return `/backoffice/internals/${scopePath}/workflows`;
      }
      const toolPath = internalTool ? `/${internalTool}` : "";
      return `/backoffice/internals/${scopePath}${toolPath}`;
    }
    default:
      return `/backoffice/dashboard/${scopePath}`;
  }
};
