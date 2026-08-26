import { type BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import type { AutomationBrowserCollections as AutomationCollections } from "@/fragno/automation/tanstack/browser-database";
export type AutomationLayoutContext = {
  selectedScope: BackofficeScopeSelection;
  collections: AutomationCollections;
};

export type AutomationTab =
  | "dashboard"
  | "store"
  | "api"
  | "events-catalog"
  | "integrations"
  | "mcp"
  | "sandboxes";
