import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  backofficeContextScopeRoutePath,
  backofficeScopeSinglePathSegment,
} from "@/backoffice-runtime/scope-codec";
import {
  createBrowserCollectionDatabaseLoader,
  openBrowserCollectionDatabase,
  type BrowserCollectionSourceDescription,
} from "@/fragno/tanstack/browser-collection-database";

import {
  createUploadCollections,
  type UploadCollections,
  type UploadCollectionTarget,
} from "./collections";

const UPLOAD_DATABASE_NAME = "fragno-backoffice-upload.sqlite";
const UPLOAD_DATABASE_COORDINATOR_NAME = "fragno-backoffice-upload";
const UPLOAD_COLLECTION_SCHEMA_VERSION = 1;

export type UploadCollectionSource = {
  scope: BackofficeRoutableScope;
  adapterIdentity: string;
};

export function describeUploadCollectionSource(
  source: UploadCollectionSource,
): BrowserCollectionSourceDescription<UploadCollectionTarget> {
  const scopeKey = backofficeScopeSinglePathSegment(source.scope);
  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    internalUrl: `/api/upload-scoped/${backofficeContextScopeRoutePath(source.scope)}/_internal`,
    bootstrap: { adapterIdentity: source.adapterIdentity },
    collectionId: (target) =>
      JSON.stringify(["backoffice", "upload", scopeKey, source.adapterIdentity, target]),
  };
}

export const getUploadBrowserDatabase = createBrowserCollectionDatabaseLoader({
  name: "The Upload collection database",
  open: () =>
    openBrowserCollectionDatabase<
      UploadCollectionSource,
      UploadCollections,
      UploadCollectionTarget
    >({
      databaseName: UPLOAD_DATABASE_NAME,
      coordinatorName: UPLOAD_DATABASE_COORDINATOR_NAME,
      schemaVersion: UPLOAD_COLLECTION_SCHEMA_VERSION,
      describeSource: describeUploadCollectionSource,
      createCollections: ({ coordinator, collectionId, createCollection }) =>
        createUploadCollections({ coordinator, collectionId, createCollection }),
    }),
});
