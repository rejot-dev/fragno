import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { scopedPublicMountPath } from "@/fragno/scoped-public-fragment-routes";
import {
  createBrowserCollectionDatabaseLoader,
  openBrowserCollectionDatabase,
  type BrowserCollectionSourceDescription,
} from "@/fragno/tanstack/browser-collection-database";

import { createPiCollections, type PiCollections, type PiCollectionTarget } from "./collections";

const PI_DATABASE_NAME = "fragno-backoffice-pi.sqlite";
const PI_DATABASE_COORDINATOR_NAME = "fragno-backoffice-pi";
const PI_COLLECTION_SCHEMA_VERSION = 1;

export type PiCollectionSource = {
  scope: BackofficeContextScope;
  adapterIdentity: string;
};

export function describePiCollectionSource(
  source: PiCollectionSource,
): BrowserCollectionSourceDescription<PiCollectionTarget> {
  const scopeKey = backofficeContextScopeSinglePathSegment(source.scope);

  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    internalUrl: `${scopedPublicMountPath({ publicPrefix: "/api/pi", scope: source.scope })}/_internal`,
    bootstrap: { adapterIdentity: source.adapterIdentity },
    collectionId: (target) =>
      JSON.stringify(["backoffice", "pi", scopeKey, source.adapterIdentity, target]),
  };
}

export const getPiBrowserDatabase = createBrowserCollectionDatabaseLoader({
  name: "The Pi collection database",
  open: () =>
    openBrowserCollectionDatabase<PiCollectionSource, PiCollections, PiCollectionTarget>({
      databaseName: PI_DATABASE_NAME,
      coordinatorName: PI_DATABASE_COORDINATOR_NAME,
      schemaVersion: PI_COLLECTION_SCHEMA_VERSION,
      describeSource: describePiCollectionSource,
      createCollections: ({ coordinator, collectionId, createCollection }) =>
        createPiCollections({
          coordinator,
          collectionId,
          createCollection,
        }),
    }),
});
