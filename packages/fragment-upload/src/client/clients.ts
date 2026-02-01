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
    useCompleteUpload: builder.createMutator("POST", "/uploads/:uploadId/complete"),
    useAbortUpload: builder.createMutator("POST", "/uploads/:uploadId/abort"),
    useUpdateFile: builder.createMutator("PATCH", "/files/:fileKey"),
    useDeleteFile: builder.createMutator("DELETE", "/files/:fileKey"),
    useUploadHelpers: builder.createStore(helpers),
  };
}
