import type { AutomationBrowserCollections as AutomationCollections } from "@/fragno/automation/tanstack/browser-database";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";

import type { AutomationScriptRecord } from "./data";
import type { AutomationUiScope } from "./scope";

export type AutomationLayoutContext = {
  selectedScope: AutomationUiScope;
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
