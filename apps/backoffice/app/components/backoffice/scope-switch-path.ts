import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";

const SCOPE_ROUTE_KINDS = new Set(["system", "org", "project", "user"]);

const AUTOMATION_TABS = new Set([
  "dashboard",
  "store",
  "api",
  "events-catalog",
  "integrations",
  "mcp",
  "sandboxes",
]);
const SYSTEM_UNAVAILABLE_AUTOMATION_TABS = new Set(["api", "mcp", "sandboxes"]);
const MARKETPLACE_TABS = new Set(["marketplace", "installed", "my-listings"]);

// Rebuilds the current URL for another scope: keeps the active section, keeps
// the section tab where scope-independent, and otherwise lands on the scoped
// index (which redirects to the section default).
/** Builds a browser route without accepting runtime organization identity. */
export const scopeSwitchPath = (pathname: string, scope: BackofficeRouteScope) => {
  const scopePath = backofficeRouteScopePath(scope);
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[1];
  const scoped = segments.length >= 4 && SCOPE_ROUTE_KINDS.has(segments[2] ?? "");
  const rest = scoped ? segments.slice(4) : segments.slice(2);

  switch (section) {
    case "automations": {
      const requestedTab = rest[0] && AUTOMATION_TABS.has(rest[0]) ? rest[0] : "dashboard";
      const tab =
        scope.kind === "system" && SYSTEM_UNAVAILABLE_AUTOMATION_TABS.has(requestedTab)
          ? "dashboard"
          : requestedTab;
      return `/backoffice/automations/${scopePath}/${tab}`;
    }
    case "sessions":
      return `/backoffice/sessions/${scopePath}/sessions`;
    case "files":
      return `/backoffice/files/${scopePath}`;
    case "marketplace": {
      const tab = rest[0] && MARKETPLACE_TABS.has(rest[0]) ? rest[0] : "marketplace";
      return `/backoffice/marketplace/${scopePath}/${tab}`;
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
      return `/backoffice/automations/${scopePath}/dashboard`;
  }
};
