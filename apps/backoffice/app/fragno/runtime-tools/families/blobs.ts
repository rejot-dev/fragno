import { z } from "zod";

import {
  backofficeApiOperationToolFields,
  codemodeBytesSchema,
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
      activity: { label: "Start blob upload", target: (input) => input.key },
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).createUpload(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.completeUpload"),
      namespace: "blobs",
      name: "completeUpload",
      activity: { label: "Finish blob upload", target: (input) => input.uploadId },
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).completeUpload(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.get"),
      namespace: "blobs",
      name: "get",
      activity: { label: "Read blob details", target: (input) => input.key },
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).get(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.list"),
      namespace: "blobs",
      name: "list",
      activity: { label: "List blobs", target: (input) => input.prefix ?? null },
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).list(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.createDownloadUrl"),
      namespace: "blobs",
      name: "createDownloadUrl",
      activity: { label: "Create blob download link", target: (input) => input.key },
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).createDownloadUrl(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.read"),
      outputSchema: z.object({
        content: codemodeBytesSchema,
        etag: z
          .string()
          .describe("The tag of the bytes read; it changes when the blob is replaced."),
      }),
      namespace: "blobs",
      name: "read",
      activity: { label: "Read blob", target: (input) => input.key },
      execute: async (input, context: BlobsToolContext) =>
        await getBlobsRuntime(context).read(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("blobs.delete"),
      namespace: "blobs",
      name: "delete",
      activity: { label: "Delete blob", target: (input) => input.key },
      execute: async (input, context: BlobsToolContext) => {
        await getBlobsRuntime(context).delete(input);
      },
    }),
  ],
  isAvailable: (context: BlobsToolContext) => !!context.runtimes.blobs,
});
