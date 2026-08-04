import { z } from "zod";

import {
  backofficeRoutableScopesEqual,
  isBackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import {
  preparedUploadedFileReferenceSchema,
  uploadedFileReferenceSchema,
} from "@/fragno/prepared-upload";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";
import type { UploadRuntime } from "@/fragno/runtime-tools/families/upload-runtime";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

const uploadReadPreparedInputSchema = z.object({
  file: preparedUploadedFileReferenceSchema,
  encoding: z.enum(["utf8", "base64", "bytes"]).optional(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1_024 * 1_024)
    .optional(),
});

const uploadReadPreparedOutputFields = {
  file: preparedUploadedFileReferenceSchema,
  byteLength: z.number().int().nonnegative(),
};

const uploadReadPreparedOutputSchema = z.discriminatedUnion("encoding", [
  z.object({
    ...uploadReadPreparedOutputFields,
    encoding: z.literal("utf8"),
    text: z.string(),
  }),
  z.object({
    ...uploadReadPreparedOutputFields,
    encoding: z.literal("base64"),
    base64: z.string(),
  }),
  z.object({
    ...uploadReadPreparedOutputFields,
    encoding: z.literal("bytes"),
    bytes: z
      .custom<Uint8Array>((value) => value instanceof Uint8Array)
      .meta({ codemodeType: "Uint8Array" }),
  }),
]);

const uploadPreparedInputSchema = z.object({
  file: preparedUploadedFileReferenceSchema,
});

const uploadDiscardPreparedOutputSchema = z.object({
  discarded: z.literal(true),
  uploadId: z.string().trim().min(1),
});

type UploadToolContext = BackofficeToolContext<{ upload?: UploadRuntime }>;

const defineUploadTool = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, UploadToolContext>,
) => defineBackofficeRuntimeTool(tool);

const getUploadRuntime = (context: UploadToolContext): UploadRuntime => {
  const runtime = context.runtimes.upload;
  if (!runtime) {
    throw new Error("Upload runtime is not available in this execution context.");
  }
  return runtime;
};

const assertPreparedFileScope = (
  context: UploadToolContext,
  file: z.output<typeof preparedUploadedFileReferenceSchema>,
) => {
  if (
    !isBackofficeRoutableScope(context.execution.scope) ||
    !backofficeRoutableScopesEqual(context.execution.scope, file.scope)
  ) {
    throw new Error(
      "Prepared upload scope must match the scoped Upload provider used for the operation.",
    );
  }
};

const parseReadPrepared = defineCliArgsParser<z.input<typeof uploadReadPreparedInputSchema>>(
  "upload.prepared.read",
  {
    file: { kind: "json", option: "file-json", required: true },
    encoding: {},
    maxBytes: { kind: "positiveInteger" },
  },
);

const parsePreparedFile = (command: string) =>
  defineCliArgsParser<z.input<typeof uploadPreparedInputSchema>>(command, {
    file: { kind: "json", option: "file-json", required: true },
  });

const bytesToBinaryString = (bytes: Uint8Array) => {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return binary;
};

const readPreparedTool = defineUploadTool({
  id: "upload.prepared.read",
  namespace: "upload",
  name: "readPrepared",
  capabilityId: "upload",
  description: "Read the content of a prepared private upload before commit or discard.",
  requiredPermissions: ["read"],
  getResource: ({ file }) => ({ uploadId: file.uploadId }),
  inputSchema: uploadReadPreparedInputSchema,
  outputSchema: uploadReadPreparedOutputSchema,
  execute: async (input, context) => {
    assertPreparedFileScope(context, input.file);
    return await getUploadRuntime(context).readPrepared(input);
  },
  adapters: {
    bash: {
      command: "upload.prepared.read",
      help: {
        summary: "Read one prepared upload as UTF-8, base64, or bytes.",
        options: [
          {
            name: "file-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Prepared-upload reference as JSON.",
          },
          {
            name: "encoding",
            valueRequired: true,
            valueName: "utf8|base64|bytes",
            description: "Content encoding; defaults to utf8.",
          },
          {
            name: "max-bytes",
            valueRequired: true,
            valueName: "number",
            description: "Maximum bytes to read.",
          },
        ],
      },
      parse: parseReadPrepared,
      format: (result, options) => {
        if (options.format === "json") {
          return { data: result };
        }
        if (result.encoding === "utf8") {
          return { stdout: result.text };
        }
        if (result.encoding === "base64") {
          return { stdout: result.base64 };
        }
        return {
          stdout: bytesToBinaryString(result.bytes),
          stdoutEncoding: "binary" as const,
        };
      },
    },
  },
});

const commitPreparedTool = defineUploadTool({
  id: "upload.prepared.commit",
  namespace: "upload",
  name: "commitPrepared",
  capabilityId: "upload",
  description: "Commit a prepared private upload so the file persists.",
  requiredPermissions: ["modify"],
  getResource: ({ file }) => ({ uploadId: file.uploadId }),
  inputSchema: uploadPreparedInputSchema,
  outputSchema: uploadedFileReferenceSchema,
  execute: async (input, context) => {
    assertPreparedFileScope(context, input.file);
    return await getUploadRuntime(context).commitPrepared(input);
  },
  adapters: {
    bash: {
      command: "upload.prepared.commit",
      help: {
        summary: "Commit one prepared upload.",
        options: [
          {
            name: "file-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Prepared-upload reference as JSON.",
          },
        ],
      },
      parse: parsePreparedFile("upload.prepared.commit"),
      format: (result, options) =>
        options.format === "json" ? { data: result } : { stdout: `${result.fileKey}\n` },
    },
  },
});

const discardPreparedTool = defineUploadTool({
  id: "upload.prepared.discard",
  namespace: "upload",
  name: "discardPrepared",
  capabilityId: "upload",
  description: "Discard a temporary prepared private upload.",
  requiredPermissions: ["modify"],
  getResource: ({ file }) => ({ uploadId: file.uploadId }),
  inputSchema: uploadPreparedInputSchema,
  outputSchema: uploadDiscardPreparedOutputSchema,
  execute: async (input, context) => {
    assertPreparedFileScope(context, input.file);
    return await getUploadRuntime(context).discardPrepared(input);
  },
  adapters: {
    bash: {
      command: "upload.prepared.discard",
      help: {
        summary: "Discard one prepared upload.",
        options: [
          {
            name: "file-json",
            required: true,
            valueRequired: true,
            valueName: "json",
            description: "Prepared-upload reference as JSON.",
          },
        ],
      },
      parse: parsePreparedFile("upload.prepared.discard"),
      format: (result, options) =>
        options.format === "json" ? { data: result } : { stdout: `${result.uploadId}\n` },
    },
  },
});

export const uploadRuntimeTools = [
  readPreparedTool,
  commitPreparedTool,
  discardPreparedTool,
] as const;

export const uploadToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "upload",
  permissions: {
    read: "Read prepared private uploads.",
    modify: "Commit or discard prepared private uploads.",
  },
  tools: uploadRuntimeTools,
  isAvailable: (context: UploadToolContext) => !!context.runtimes.upload,
});
