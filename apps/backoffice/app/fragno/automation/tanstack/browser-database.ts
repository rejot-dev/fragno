import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeContextScopeSinglePathSegment,
  backofficeScopeRouteId,
} from "@/backoffice-runtime/scope-codec";
import {
  createBrowserCollectionDatabaseLoader,
  openBrowserCollectionDatabase,
  type BrowserCollectionSourceDescription,
} from "@/fragno/tanstack/browser-collection-database";

import {
  createAutomationCollections,
  type AutomationCollections,
  type AutomationCollectionTarget,
} from "./collections";

const AUTOMATION_DATABASE_NAME = "fragno-backoffice-automations.sqlite";
const AUTOMATION_DATABASE_COORDINATOR_NAME = "fragno-backoffice-automations";
const AUTOMATION_COLLECTION_SCHEMA_VERSION = 2;

export type AutomationCollectionSource = {
  scope: BackofficeContextScope;
  adapterIdentity: string;
};

export function describeAutomationCollectionSource(
  source: AutomationCollectionSource,
): BrowserCollectionSourceDescription<AutomationCollectionTarget> {
  const scopeKey = backofficeContextScopeSinglePathSegment(source.scope);
  const routeScopeId = encodeURIComponent(
    source.scope.kind === "system" ? "system" : backofficeScopeRouteId(source.scope),
  );

  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    internalUrl: `/api/automations-scoped/${source.scope.kind}/${routeScopeId}/_internal`,
    bootstrap: { adapterIdentity: source.adapterIdentity },
    collectionId: (target) =>
      JSON.stringify(["backoffice", "automations", scopeKey, source.adapterIdentity, target]),
  };
}

export const getAutomationBrowserDatabase = createBrowserCollectionDatabaseLoader({
  name: "The Automation collection database",
  open: () =>
    openBrowserCollectionDatabase<
      AutomationCollectionSource,
      AutomationCollections,
      AutomationCollectionTarget
    >({
      databaseName: AUTOMATION_DATABASE_NAME,
      coordinatorName: AUTOMATION_DATABASE_COORDINATOR_NAME,
      schemaVersion: AUTOMATION_COLLECTION_SCHEMA_VERSION,
      describeSource: describeAutomationCollectionSource,
      createCollections: ({ coordinator, collectionId, createCollection }) =>
        createAutomationCollections({
          coordinator,
          collectionId,
          createCollection,
        }),
    }),
});
