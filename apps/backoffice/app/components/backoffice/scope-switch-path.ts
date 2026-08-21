import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

const SCOPE_ROUTE_KINDS = new Set(["system", "org", "project", "user"]);

const AUTOMATION_TABS = new Set([
  "dashboard",
  "scripts",
  "router",
  "store",
  "api",
  "events",
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
export const scopeSwitchPath = (pathname: string, scope: BackofficeContextScope) => {
  const scopePath = backofficeContextScopeRoutePath(scope);
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[1];
  const scoped = segments.length >= 4 && SCOPE_ROUTE_KINDS.has(segments[2] ?? "");
  const rest = scoped ? segments.slice(4) : segments.slice(2);

  switch (section) {
    case "automations": {
      const requestedTab = rest[0] && AUTOMATION_TABS.has(rest[0]) ? rest[0] : "dashboard";
      const tab =
        scope.kind === "system" && SYSTEM_UNAVAILABLE_AUTOMATION_TABS.has(requestedTab)
          ? "scripts"
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
      const internalTool = segments[2];
      if (internalTool === "durable-hooks") {
        const objectId = segments[5];
        const objectPath = objectId ? `/${encodeURIComponent(objectId)}` : "";
        return `/backoffice/internals/durable-hooks/${scopePath}${objectPath}`;
      }
      if (internalTool === "workflows") {
        return `/backoffice/internals/workflows/${scopePath}`;
      }
      return pathname;
    }
    default:
      return `/backoffice/automations/${scopePath}/dashboard`;
  }
};
