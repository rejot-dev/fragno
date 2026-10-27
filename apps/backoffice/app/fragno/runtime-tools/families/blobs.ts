import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { BlobsRuntime } from "./blobs-runtime";

type BlobsToolContext = BackofficeToolContext<{ blobs?: BlobsRuntime }>;

function getBlobsRuntime(context: BlobsToolContext): BlobsRuntime {
  const runtime = context.runtimes.blobs;
  if (!runtime) {
    throw new Error("Blobs are not available in this execution context.");
  }
  return runtime;
}

export const blobsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "blobs",
  tools: [
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.createUpload"),
      namespace: "blobs",
      name: "createUpload",
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).createUpload(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.completeUpload"),
      namespace: "blobs",
      name: "completeUpload",
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).completeUpload(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.get"),
      namespace: "blobs",
      name: "get",
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).get(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.list"),
      namespace: "blobs",
      name: "list",
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).list(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.createDownloadUrl"),
      namespace: "blobs",
      name: "createDownloadUrl",
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).createDownloadUrl(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.delete"),
      namespace: "blobs",
      name: "delete",
      execute: async (input, context: BlobsToolContext) => {
        await getBlobsRuntime(context).delete(input);
      },
    }),
  ],
  isAvailable: (context: BlobsToolContext) => !!context.runtimes.blobs,
});
