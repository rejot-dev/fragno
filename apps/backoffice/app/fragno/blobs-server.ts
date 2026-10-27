import type { BackofficeJurisdiction } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller, type RouteCallerForFragment } from "@fragno-dev/core/api";
import { AwsClient } from "aws4fetch";

import { createBlobsFragment, createS3BlobStorage, type S3Signer } from "@fragno-dev/blobs";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeObjectScope, FetchCommands } from "@/backoffice-runtime/object-registry";

/** An R2 bucket whose blobs scopes share, each under its own prefix, reached through R2's S3 API. */
export type BlobsR2Bucket = {
  /**
   * The absolute S3 API endpoint, `https://<account>.r2.cloudflarestorage.com` for R2. Presigned
   * URLs point here, so it must be reachable from sandboxes and from people outside Backoffice.
   */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** Blobs storage, and the `fetch` that sends its signed requests to R2. */
export type BlobsR2Storage = { bucket: BlobsR2Bucket; fetch: typeof fetch };

/**
 * The bucket keeping each jurisdiction's blobs, so they stay where the scope's Durable Objects are;
 * `none` keeps the blobs of scopes without a jurisdiction.
 */
export type BlobsR2Buckets = Record<BackofficeJurisdiction | "none", BlobsR2Bucket>;

/** How the deployment places Durable Objects, as `DURABLE_OBJECT_JURISDICTIONS` says. */
export type BlobsJurisdictions = "enforced" | "local";

type BlobsR2Env = Pick<
  BackofficeRuntimeEnv,
  | "BLOBS_R2_ENDPOINT"
  | "BLOBS_R2_BUCKET"
  | "BLOBS_R2_ACCESS_KEY_ID"
  | "BLOBS_R2_SECRET_ACCESS_KEY"
  | "DOCS_PUBLIC_BASE_URL"
>;

/**
 * Blobs are unavailable until all four settings are present; a partial configuration is an error.
 * Enforced jurisdictions keep a jurisdiction's blobs in the bucket of the same name created in it,
 * which R2 serves at its own endpoint. Locally one bucket keeps them all, as workerd does not
 * implement jurisdictions.
 */
export function blobsR2BucketsFromEnv(
  env: BlobsR2Env,
  jurisdictions: BlobsJurisdictions,
): BlobsR2Buckets | null {
  const bucket = blobsR2BucketFromEnv(env);
  if (!bucket) {
    return null;
  }
  if (jurisdictions === "local") {
    return { none: bucket, eu: bucket, us: bucket };
  }
  return { none: bucket, eu: inJurisdiction(bucket, "eu"), us: inJurisdiction(bucket, "us") };
}

// R2 fixes a bucket's jurisdiction when the bucket is created, and serves it only at
// `https://<account>.<jurisdiction>.r2.cloudflarestorage.com`.
function inJurisdiction(bucket: BlobsR2Bucket, jurisdiction: BackofficeJurisdiction) {
  const endpoint = new URL(bucket.endpoint);
  const account = /^([^.]+)\.r2\.cloudflarestorage\.com$/.exec(endpoint.hostname)?.[1];
  if (!account) {
    throw new Error(
      `BLOBS_R2_ENDPOINT must be an R2 account endpoint, https://<account>.r2.cloudflarestorage.com, to keep each jurisdiction's blobs apart; ${bucket.endpoint} is not. Only local development sets DURABLE_OBJECT_JURISDICTIONS=local.`,
    );
  }
  endpoint.hostname = `${account}.${jurisdiction}.r2.cloudflarestorage.com`;
  return { ...bucket, endpoint: endpoint.toString() };
}

/**
 * An endpoint path, such as Miniflare's local `/cdn-cgi/local/r2/s3`, is served by this deployment
 * and resolves against its public URL, so a dev server behind a tunnel hands out URLs that
 * sandboxes and people elsewhere can reach.
 */
function blobsR2BucketFromEnv(env: BlobsR2Env): BlobsR2Bucket | null {
  const settings = {
    endpoint: env.BLOBS_R2_ENDPOINT?.trim() ?? "",
    bucket: env.BLOBS_R2_BUCKET?.trim() ?? "",
    accessKeyId: env.BLOBS_R2_ACCESS_KEY_ID?.trim() ?? "",
    secretAccessKey: env.BLOBS_R2_SECRET_ACCESS_KEY?.trim() ?? "",
  };
  const missing = Object.entries(settings).filter(([, value]) => value === "");
  if (missing.length === Object.keys(settings).length) {
    return null;
  }
  if (missing.length > 0) {
    throw new Error(
      "Blobs need BLOBS_R2_ENDPOINT, BLOBS_R2_BUCKET, BLOBS_R2_ACCESS_KEY_ID, and BLOBS_R2_SECRET_ACCESS_KEY together.",
    );
  }
  if (!settings.endpoint.startsWith("/")) {
    return settings;
  }
  const publicBaseUrl = env.DOCS_PUBLIC_BASE_URL?.trim();
  if (!publicBaseUrl) {
    throw new Error(
      `BLOBS_R2_ENDPOINT ${settings.endpoint} needs DOCS_PUBLIC_BASE_URL to resolve.`,
    );
  }
  return { ...settings, endpoint: new URL(settings.endpoint, publicBaseUrl).toString() };
}

function createR2Signer(bucket: BlobsR2Bucket): S3Signer {
  const client = new AwsClient({
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  return {
    sign: async ({ url, method }) => {
      const request = await client.sign(url, { method });
      return { url: request.url, headers: Object.fromEntries(request.headers) };
    },
    presign: async ({ url, method, headers, expiresInSeconds }) => {
      const presignedUrl = new URL(url);
      presignedUrl.searchParams.set("X-Amz-Expires", String(Math.floor(expiresInSeconds)));
      const request = await client.sign(presignedUrl.toString(), {
        method,
        headers,
        aws: { signQuery: true },
      });
      return { url: request.url, headers: Object.fromEntries(request.headers) };
    },
  };
}

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
