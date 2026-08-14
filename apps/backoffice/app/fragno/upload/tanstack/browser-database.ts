import { uploadSchema } from "@fragno-dev/upload/schema";

import { createFragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter";

import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  backofficeContextScopeRoutePath,
  backofficeScopeSinglePathSegment,
} from "@/backoffice-runtime/scope-codec";
import {
  createBrowserCollectionDatabaseLoader,
  createCollectionResourceRegistry,
  type BrowserCollectionDatabase,
} from "@/fragno/tanstack/browser-collection-database";

import { createUploadCollections, type UploadCollections } from "./collections";

export type UploadCollectionSource = {
  scope: BackofficeRoutableScope;
  adapterIdentity: string;
};

export function describeUploadCollectionSource(source: UploadCollectionSource) {
  const scopeKey = backofficeScopeSinglePathSegment(source.scope);
  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    baseUrl: `/api/upload-scoped/${backofficeContextScopeRoutePath(source.scope)}`,
  };
}

export const getUploadBrowserDatabase = createBrowserCollectionDatabaseLoader({
  name: "The Upload collection database",
  async open(): Promise<BrowserCollectionDatabase<UploadCollectionSource, UploadCollections>> {
    const resources = createCollectionResourceRegistry({
      resourceKey: (source: UploadCollectionSource) =>
        describeUploadCollectionSource(source).resourceKey,
      createResource: (source: UploadCollectionSource) => {
        const description = describeUploadCollectionSource(source);
        const resource = (async () => {
          const coordinator = await createFragnoOutboxCoordinator({
            baseUrl: description.baseUrl,
            fetch: (input, init) => globalThis.fetch(input, init),
            schemas: [uploadSchema] as const,
          });
          const collections = createUploadCollections(coordinator);

          try {
            await coordinator.preload();
            return collections;
          } catch (error) {
            await coordinator.cleanup().catch(() => {});
            throw error;
          }
        })();
        void resource.catch(() => {});
        return resource;
      },
    });

    return {
      readyCollectionsFor(source) {
        return resources.resourceFor(source);
      },
    };
  },
});
