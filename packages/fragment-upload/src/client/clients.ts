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
    useFile: builder.createHook("/files/by-key"),
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
    useUpdateFile: builder.createMutator("PATCH", "/files/by-key", (invalidate, params) => {
      const provider = params.queryParams?.["provider"];
      const key = params.queryParams?.["key"];
      if (!provider || !key) {
        return;
      }
      invalidate("GET", "/files/by-key", { queryParams: { provider, key } });
      invalidate("GET", "/files", {});
    }),
    useDeleteFile: builder.createMutator("DELETE", "/files/by-key", (invalidate, params) => {
      const provider = params.queryParams?.["provider"];
      const key = params.queryParams?.["key"];
      if (!provider || !key) {
        return;
      }
      invalidate("GET", "/files/by-key", { queryParams: { provider, key } });
      invalidate("GET", "/files", {});
    }),
    useUploadHelpers: builder.createStore(helpers),
  };
}
