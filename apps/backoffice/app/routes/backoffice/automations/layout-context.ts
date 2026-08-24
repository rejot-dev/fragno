import { type BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import type { AutomationBrowserCollections as AutomationCollections } from "@/fragno/automation/tanstack/browser-database";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";

import type { AutomationScriptRecord } from "./data";

export type AutomationLayoutContext = {
  selectedScope: BackofficeScopeSelection;
  scripts: AutomationScriptRecord[];
  scriptsError: string | null;
  collections: AutomationCollections;
  uploadCollectionSource: UploadCollectionSource | null;
  uploadCollectionError: string | null;
};

export type AutomationTab =
  | "dashboard"
  | "scripts"
  | "router"
  | "store"
  | "api"
  | "events"
  | "events-catalog"
  | "integrations"
  | "mcp"
  | "sandboxes";
