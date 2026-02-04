import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../routes";
import { createUploadHelpers } from "./helpers";

export function createUploadFragmentClients(config: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(uploadFragmentDefinition, config, uploadRoutes);
  const { fetcher, defaultOptions } = builder.getFetcher();
  const helpers = createUploadHelpers({
    buildUrl: (path) => builder.buildUrl(path),
    fetcher,
    defaultOptions,
  });

  return {
    useFiles: builder.createHook("/files"),
    useFile: builder.createHook("/files/:fileKey"),
    useCreateUpload: builder.createMutator("POST", "/uploads"),
    useUploadStatus: builder.createHook("/uploads/:uploadId"),
    useCompleteUpload: builder.createMutator(
      "POST",
      "/uploads/:uploadId/complete",
      (invalidate, params) => {
        const uploadId = params.pathParams.uploadId;
        if (!uploadId) {
          return;
        }
        invalidate("GET", "/uploads/:uploadId", { pathParams: { uploadId } });
        invalidate("GET", "/files", {});
      },
    ),
    useAbortUpload: builder.createMutator(
      "POST",
      "/uploads/:uploadId/abort",
      (invalidate, params) => {
        const uploadId = params.pathParams.uploadId;
        if (!uploadId) {
          return;
        }
        invalidate("GET", "/uploads/:uploadId", { pathParams: { uploadId } });
      },
    ),
    useUpdateFile: builder.createMutator("PATCH", "/files/:fileKey", (invalidate, params) => {
      const fileKey = params.pathParams.fileKey;
      if (!fileKey) {
        return;
      }
      invalidate("GET", "/files/:fileKey", { pathParams: { fileKey } });
      invalidate("GET", "/files", {});
    }),
    useDeleteFile: builder.createMutator("DELETE", "/files/:fileKey", (invalidate, params) => {
      const fileKey = params.pathParams.fileKey;
      if (!fileKey) {
        return;
      }
      invalidate("GET", "/files/:fileKey", { pathParams: { fileKey } });
      invalidate("GET", "/files", {});
    }),
    useUploadHelpers: builder.createStore(helpers),
  };
}
