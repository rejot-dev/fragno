import type {
  Blob,
  BlobDownloadUrl,
  BlobPage,
  BlobUpload,
} from "@fragno-dev/backoffice-api/v0/blobs";

import type { FetchCommands } from "@/backoffice-runtime/object-registry";
import { createBlobsRouteCaller } from "@/fragno/blobs-server";

import {
  isSuccessStatus,
  throwOnHttpResponseError,
  throwOnRouteRuntimeError,
} from "../runtime-errors";

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

/** One scope's blobs, through the routes of its Blobs object. */
export function createBlobsRuntime({ object }: { object: () => FetchCommands }): BlobsRuntime {
  const callRoute = () => createBlobsRouteCaller(object());

  return {
    async createUpload({ key, contentType }) {
      const response = await callRoute()("POST", "/uploads", { body: { key, contentType } });
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
      const response = await callRoute()("POST", "/uploads/:uploadId/complete", {
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
      const response = await callRoute()("GET", "/blobs/by-key", { query: { key } });
      if (response.type === "error" && response.error.code === "BLOB_NOT_FOUND") {
        return null;
      }
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.get" });
      }
      return response.data;
    },
    async list({ prefix, cursor }) {
      const response = await callRoute()("GET", "/blobs", {
        query: { ...(prefix ? { prefix } : {}), ...(cursor ? { cursor } : {}) },
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.list" });
      }
      return response.data;
    },
    async createDownloadUrl({ key }) {
      const response = await callRoute()("GET", "/blobs/by-key/download-url", {
        query: { key },
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
      const response = await callRoute().raw("GET", "/blobs/by-key/range", {
        query: { key, offset: String(offset), length: String(length) },
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
      const response = await callRoute()("DELETE", "/blobs/by-key", { query: { key } });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        throwOnRouteRuntimeError(response, { runtimeLabel: "Blobs", label: "blobs.delete" });
      }
    },
  };
}
