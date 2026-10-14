import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import type { AutomationBrowserCollections } from "@/fragno/automation/tanstack/browser-database";

import type { IntegrationConnectionStateChange } from "./connection-overview";

export type IntegrationsLayoutContext = {
  selectedScope: BackofficeScopeSelection;
  collections: AutomationBrowserCollections;
  /** Every connection state change in the scope, newest first. */
  changes: IntegrationConnectionStateChange[];
};
