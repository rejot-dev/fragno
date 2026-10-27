import {
  BLOB_MAX_SIZE_BYTES,
  type Blob,
  type BlobDownloadUrl,
  type BlobPage,
  type BlobUpload,
} from "@fragno-dev/backoffice-api/v0/blobs";

import type { FetchCommands } from "@/backoffice-runtime/object-registry";
import { BLOBS_PROVIDER, createBlobsRouteCaller } from "@/fragno/blobs-server";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

export type BlobsRuntime = {
  createUpload(input: { key: string; contentType: string }): Promise<BlobUpload>;
  completeUpload(input: { uploadId: string }): Promise<Blob>;
  get(input: { key: string }): Promise<Blob | null>;
  list(input: { prefix?: string; cursor?: string }): Promise<BlobPage>;
  createDownloadUrl(input: { key: string }): Promise<BlobDownloadUrl>;
  delete(input: { key: string }): Promise<void>;
};

const BLOBS_LIST_PAGE_SIZE = 100;

function toBlob(file: { fileKey: string; sizeBytes: number; contentType: string }): Blob {
  return { key: file.fileKey, sizeBytes: file.sizeBytes, contentType: file.contentType };
}

/** One scope's blobs, through the routes of its Blobs object. */
export function createBlobsRuntime({ object }: { object: () => FetchCommands }): BlobsRuntime {
  const callRoute = () => createBlobsRouteCaller(object());

  return {
    async createUpload({ key, contentType }) {
      const response = await callRoute()("POST", "/uploads", {
        body: {
          provider: BLOBS_PROVIDER,
          fileKey: key,
          filename: key.slice(key.lastIndexOf("/") + 1),
          // The uploader may not know the size; storage records it and checks it against this
          // maximum when the upload completes.
          sizeBytes: BLOB_MAX_SIZE_BYTES,
          contentType,
          replaceActiveUpload: true,
        },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, {
          runtimeLabel: "Blobs",
          label: "blobs.createUpload",
        });
      }
      const { uploadId, fileKey, upload, expiresAt } = response.data;
      // The adapter is configured so that every blob fits one presigned PUT.
      if (!upload.uploadUrl) {
        throw new Error("Blobs storage did not return a presigned upload URL.");
      }
      return {
        uploadId,
        key: fileKey,
        url: upload.uploadUrl,
        headers: upload.uploadHeaders ?? {},
        // Typed as a Date, but route responses arrive as JSON, where it is an ISO string.
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
    async completeUpload({ uploadId }) {
      const response = await callRoute()("POST", "/uploads/:uploadId/complete", {
        pathParams: { uploadId },
        body: {},
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, {
          runtimeLabel: "Blobs",
          label: "blobs.completeUpload",
        });
      }
      // Blobs publish immediately; only batch uploads complete as prepared.
      if (response.data.kind !== "published") {
        throw new Error("Blobs storage prepared the upload instead of publishing it.");
      }
      return toBlob(response.data.file);
    },
    async get({ key }) {
      const response = await callRoute()("GET", "/files/by-key", {
        query: { provider: BLOBS_PROVIDER, key },
      });
      if (response.type === "error" && response.error.code === "FILE_NOT_FOUND") {
        return null;
      }
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.get" });
      }
      return response.data.status === "ready" ? toBlob(response.data) : null;
    },
    async list({ prefix, cursor }) {
      const response = await callRoute()("GET", "/files", {
        query: {
          provider: BLOBS_PROVIDER,
          status: "ready",
          pageSize: String(BLOBS_LIST_PAGE_SIZE),
          ...(prefix ? { prefix } : {}),
          ...(cursor ? { cursor } : {}),
        },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.list" });
      }
      return {
        blobs: response.data.files.map(toBlob),
        cursor: response.data.hasNextPage ? (response.data.cursor ?? null) : null,
      };
    },
    async createDownloadUrl({ key }) {
      const response = await callRoute()("GET", "/files/by-key/download-url", {
        query: { provider: BLOBS_PROVIDER, key },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, {
          runtimeLabel: "Blobs",
          label: "blobs.createDownloadUrl",
        });
      }
      return { url: response.data.url, expiresAt: new Date(response.data.expiresAt).toISOString() };
    },
    async delete({ key }) {
      const response = await callRoute()("DELETE", "/files/by-key", {
        query: { provider: BLOBS_PROVIDER, key },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.delete" });
      }
    },
  };
}
