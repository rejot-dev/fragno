import { createRouteCaller, type RouteCallerForFragment } from "@fragno-dev/core/api";

import { createBlobsFragment, createS3BlobStorage } from "@fragno-dev/blobs";

import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeObjectScope, FetchCommands } from "@/backoffice-runtime/object-registry";

import { createR2Signer, type BlobsR2Bucket } from "./blobs-r2-buckets";

/** Blobs storage, and the `fetch` that sends its signed requests to R2. */
type BlobsR2Storage = { bucket: BlobsR2Bucket; fetch: typeof fetch };

function storagePrefixSegment(value: string): string {
  const segment = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`'${value}' cannot be converted into a storage key prefix.`);
  }
  return segment;
}

/**
 * Prefixes every object key a scope's Blobs object writes, so scopes sharing a bucket never address
 * each other's objects. Organizations are named by their id; every other scope by its encoded
 * object name.
 */
export function scopeStorageKeyPrefix(
  scope: Exclude<BackofficeObjectScope, { kind: "singleton" }>,
  objectName: string,
): string {
  if (scope.kind === "org") {
    return `org/${storagePrefixSegment(scope.orgId)}`;
  }
  const name = scope.kind === "named" ? scope.name : objectName;
  return `named/${name.split("/").map(storagePrefixSegment).join("/")}`;
}

export function createBlobsServer({
  storage,
  storageKeyPrefix,
  runtime,
}: {
  storage: BlobsR2Storage;
  storageKeyPrefix: string;
  runtime: BackofficeFragmentRuntimeOptions;
}): ReturnType<typeof createBlobsFragment> {
  const databaseAdapter = runtime.adapters.createAdapter({ kind: "blobs" });

  return createBlobsFragment(
    {
      storage: createS3BlobStorage({
        endpoint: storage.bucket.endpoint,
        bucket: storage.bucket.bucket,
        pathStyle: true,
        signer: createR2Signer(storage.bucket),
        fetch: storage.fetch,
      }),
      storageKeyPrefix,
    },
    { databaseAdapter, mountRoute: "/api/blobs" },
  );
}

export type BlobsFragment = ReturnType<typeof createBlobsServer>;

export type BlobsRouteCaller = RouteCallerForFragment<BlobsFragment>;

export function createBlobsRouteCaller(object: FetchCommands): BlobsRouteCaller {
  return createRouteCaller<BlobsFragment>({
    baseUrl: "https://blobs.internal",
    mountRoute: "/api/blobs",
    fetch: (request) => object.fetch(request),
  });
}
