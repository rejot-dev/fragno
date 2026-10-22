import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import type { AutomationBrowserCollections } from "@/fragno/automation/tanstack/browser-database";

export type IntegrationsLayoutContext = {
  selectedScope: BackofficeScopeSelection;
  collections: AutomationBrowserCollections;
};
