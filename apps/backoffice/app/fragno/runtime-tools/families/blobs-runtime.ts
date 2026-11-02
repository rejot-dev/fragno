import type {
  Blob,
  BlobDownloadUrl,
  BlobPage,
  BlobUpload,
} from "@fragno-dev/backoffice-api/v0/blobs";
import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { SHARED_MOUNT_POINT } from "@fragno-dev/backoffice-api/v0/shares";

import type { FetchCommands } from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { createBlobsRouteCaller } from "@/fragno/blobs-server";

import {
  isSuccessStatus,
  throwOnHttpResponseError,
  throwOnRouteRuntimeError,
} from "../runtime-errors";
import type { AcceptedShares } from "../shares-runtime";

export type BlobsRuntime = {
  createUpload(input: { key: string; contentType: string }): Promise<BlobUpload>;
  completeUpload(input: { uploadId: string }): Promise<Blob>;
  get(input: { key: string }): Promise<Blob | null>;
  list(input: { prefix?: string; cursor?: string }): Promise<BlobPage>;
  createDownloadUrl(input: { key: string }): Promise<BlobDownloadUrl>;
  read(input: {
    key: string;
    offset: number;
    length: number;
  }): Promise<{ content: Uint8Array<ArrayBuffer>; etag: string }>;
  delete(input: { key: string }): Promise<void>;
};

/** Where a blob key leads: this scope's blobs, or the blobs a share this scope accepted opens. */
type BlobLocation =
  | { kind: "own"; key: string }
  | { kind: "shared"; mount: string; object: FetchCommands; prefix: string; key: string }
  | { kind: "closed" };

const SHARED_KEYS = `${SHARED_MOUNT_POINT}/`;

/**
 * One scope's blobs, through the routes of its Blobs object, and, read-only under
 * /shared/<name>/, the blobs of shares it accepted, through the routes of the sharing scope's.
 * This scope's own keys never start with /, so the two never meet.
 */
export function createBlobsRuntime({
  object,
  shares,
  sharingObject,
}: {
  object: () => FetchCommands;
  shares: AcceptedShares;
  sharingObject: (scope: BackofficeRoutableScope) => FetchCommands;
}): BlobsRuntime {
  const ownRoutes = () => createBlobsRouteCaller(object());
  const routesAt = (location: Exclude<BlobLocation, { kind: "closed" }>) =>
    location.kind === "shared" ? createBlobsRouteCaller(location.object) : ownRoutes();

  /** A closed location is a share this scope did not accept, or one revoked since. */
  async function locate(key: string): Promise<BlobLocation> {
    if (!key.startsWith(SHARED_KEYS)) {
      return { kind: "own", key };
    }
    const rest = key.slice(SHARED_KEYS.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const accepted = await shares.find(name);
    const opened = accepted && (await shares.openBlobs(accepted));
    if (!opened) {
      return { kind: "closed" };
    }
    return {
      kind: "shared",
      mount: `${SHARED_KEYS}${name}/`,
      object: sharingObject(opened.from),
      prefix: opened.prefix,
      key: `${opened.prefix}${slash === -1 ? "" : rest.slice(slash + 1)}`,
    };
  }

  /** The blob as the caller names it: under the share's mount when it is shared. */
  function asNamed(location: BlobLocation, blob: Blob): Blob {
    return location.kind === "shared"
      ? { ...blob, key: `${location.mount}${blob.key.slice(location.prefix.length)}` }
      : blob;
  }

  function notFound(key: string): never {
    throw new BackofficeOperationError("not_found", `BLOB_NOT_FOUND: blob ${key} does not exist.`);
  }

  function assertWritable(key: string) {
    if (key.startsWith(SHARED_KEYS)) {
      throw new BackofficeOperationError(
        "forbidden",
        `Blobs under ${SHARED_KEYS} belong to the scopes that share them and are read-only.`,
      );
    }
  }

  return {
    async createUpload({ key, contentType }) {
      assertWritable(key);
      const response = await ownRoutes()("POST", "/uploads", { body: { key, contentType } });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, {
          runtimeLabel: "Blobs",
          label: "blobs.createUpload",
        });
      }
      // Typed as a Date, but route responses arrive as JSON, where it is an ISO string.
      return { ...response.data, expiresAt: new Date(response.data.expiresAt).toISOString() };
    },
    async completeUpload({ uploadId }) {
      const response = await ownRoutes()("POST", "/uploads/:uploadId/complete", {
        pathParams: { uploadId },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, {
          runtimeLabel: "Blobs",
          label: "blobs.completeUpload",
        });
      }
      return response.data;
    },
    async get({ key }) {
      const location = await locate(key);
      if (location.kind === "closed") {
        return null;
      }
      const response = await routesAt(location)("GET", "/blobs/by-key", {
        query: { key: location.key },
      });
      if (response.type === "error" && response.error.code === "BLOB_NOT_FOUND") {
        return null;
      }
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.get" });
      }
      return asNamed(location, response.data);
    },
    async list({ prefix, cursor }) {
      const location = await locate(prefix ?? "");
      if (location.kind === "closed") {
        return { blobs: [], cursor: null };
      }
      const response = await routesAt(location)("GET", "/blobs", {
        query: { ...(location.key ? { prefix: location.key } : {}), ...(cursor ? { cursor } : {}) },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.list" });
      }
      return {
        ...response.data,
        blobs: response.data.blobs.map((blob) => asNamed(location, blob)),
      };
    },
    async createDownloadUrl({ key }) {
      const location = await locate(key);
      if (location.kind === "closed") {
        return notFound(key);
      }
      const response = await routesAt(location)("GET", "/blobs/by-key/download-url", {
        query: { key: location.key },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, {
          runtimeLabel: "Blobs",
          label: "blobs.createDownloadUrl",
        });
      }
      return { url: response.data.url, expiresAt: new Date(response.data.expiresAt).toISOString() };
    },
    async read({ key, offset, length }) {
      const location = await locate(key);
      if (location.kind === "closed") {
        return notFound(key);
      }
      const response = await routesAt(location).raw("GET", "/blobs/by-key/range", {
        query: { key: location.key, offset: String(offset), length: String(length) },
      });
      if (!isSuccessStatus(response.status)) {
        return await throwOnHttpResponseError(response, {
          runtimeLabel: "Blobs",
          label: "blobs.read",
        });
      }
      return {
        content: new Uint8Array(await response.arrayBuffer()),
        // The route always sends the blob's tag, quoted as HTTP quotes it.
        etag: response.headers.get("etag")!.replace(/^"|"$/g, ""),
      };
    },
    async delete({ key }) {
      assertWritable(key);
      const response = await ownRoutes()("DELETE", "/blobs/by-key", { query: { key } });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.delete" });
      }
    },
  };
}
