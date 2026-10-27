import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { pathInputSchema, type FileLinkInput } from "@fragno-dev/backoffice-api/v0/state";
import type { ToolProvider } from "@fragno-dev/codemode/runtime-api";
import { z } from "zod";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";
import { backofficeApiOperationToolFields } from "@/fragno/runtime-tools/runtime-tools";

import type { FileLinkRuntime } from "./file-links-runtime";
import type { FileShareRuntime } from "./file-shares-runtime";
import {
  createBackofficeCodemodeProviders,
  createTrustedSystemBackofficeToolContext,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "./runtime-tools";

export type StateToolContext = BackofficeToolContext<
  Record<string, unknown> & {
    state?: BackofficeStateBackend;
    fileLinks?: FileLinkRuntime;
    fileShares?: FileShareRuntime;
  }
>;

const getStateRuntime = (context: StateToolContext): BackofficeStateBackend => {
  if (!context.runtimes.state) {
    throw new Error("State is not available in this execution context.");
  }
  return context.runtimes.state;
};

// Only scopes with an Upload workspace have file links; other state, such as /static, has none.
const getFileLinkRuntime = (context: StateToolContext): FileLinkRuntime => {
  if (!context.runtimes.fileLinks) {
    throw new Error("File links are not available in this execution context.");
  }
  return context.runtimes.fileLinks;
};

// Shares, like file links, exist only between scopes with an Upload workspace.
const getFileShareRuntime = (context: StateToolContext): FileShareRuntime => {
  if (!context.runtimes.fileShares) {
    throw new Error("File shares are not available in this execution context.");
  }
  return context.runtimes.fileShares;
};

const parseFileLink = (command: string) =>
  defineCliArgsParser<FileLinkInput>(command, {
    path: { required: true },
    expiresInSeconds: { kind: "positiveInteger" },
  });

const fileLinkHelpOptions = [
  {
    name: "path",
    required: true,
    valueRequired: true,
    valueName: "path",
    description: "A /workspace file, a folder ending in /, or a glob such as /workspace/out/**.",
  },
  {
    name: "expires-in-seconds",
    valueRequired: true,
    valueName: "seconds",
    description: "How long the link works, from 60 to 3600. Defaults to 900.",
  },
];

const bytesSchema = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array, "Expected Uint8Array")
  .meta({ codemodeType: "Uint8Array" });
export const codemodeStateToolFamily = defineBackofficeRuntimeToolFamily<StateToolContext>({
  namespace: "state",
  isAvailable: (context) => Boolean(context.runtimes.state),
  tools: [
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readFile"),
      namespace: "state",
      name: "readFile",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readFile(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.readFileBytes",
      namespace: "state",
      name: "readFileBytes",
      description: "Read a file from codemode state as bytes.",
      requiredPermissions: [BACKOFFICE_PERMISSION.upload.read],
      inputSchema: pathInputSchema,
      outputSchema: bytesSchema,
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readFileBytes(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.writeFile"),
      namespace: "state",
      name: "writeFile",
      execute: async ({ path, content }, context: StateToolContext) => {
        await getStateRuntime(context).writeFile(path, content);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.writeFileBytes",
      namespace: "state",
      name: "writeFileBytes",
      description: "Write bytes to mutable codemode state.",
      requiredPermissions: [BACKOFFICE_PERMISSION.upload.modify],
      inputSchema: z.strictObject({
        path: z.string(),
        content: bytesSchema,
      }),
      outputSchema: z.void(),
      execute: async ({ path, content }, context: StateToolContext) => {
        await getStateRuntime(context).writeFileBytes(path, content);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.appendFile",
      namespace: "state",
      name: "appendFile",
      description: "Append text or bytes to a file in mutable codemode state.",
      requiredPermissions: [BACKOFFICE_PERMISSION.upload.modify],
      inputSchema: z.strictObject({
        path: z.string(),
        content: z.union([z.string(), bytesSchema]),
      }),
      outputSchema: z.void(),
      execute: async ({ path, content }, context: StateToolContext) => {
        await getStateRuntime(context).appendFile(path, content);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.exists"),
      namespace: "state",
      name: "exists",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).exists(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.stat"),
      namespace: "state",
      name: "stat",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).stat(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.lstat"),
      namespace: "state",
      name: "lstat",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).lstat(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.mkdir"),
      namespace: "state",
      name: "mkdir",
      execute: async ({ path }, context: StateToolContext) => {
        await getStateRuntime(context).mkdir(path);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readdir"),
      namespace: "state",
      name: "readdir",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readdir(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readdirWithFileTypes"),
      namespace: "state",
      name: "readdirWithFileTypes",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readdirWithFileTypes(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.rm"),
      namespace: "state",
      name: "rm",
      execute: async ({ path, options }, context: StateToolContext) => {
        await getStateRuntime(context).rm(path, options);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.cp"),
      namespace: "state",
      name: "cp",
      execute: async ({ src, dest }, context: StateToolContext) => {
        await getStateRuntime(context).cp(src, dest);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.mv"),
      namespace: "state",
      name: "mv",
      execute: async ({ src, dest }, context: StateToolContext) => {
        await getStateRuntime(context).mv(src, dest);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.realpath"),
      namespace: "state",
      name: "realpath",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).realpath(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.resolvePath"),
      namespace: "state",
      name: "resolvePath",
      execute: async ({ base, path }, context: StateToolContext) =>
        getStateRuntime(context).resolvePath(base, path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.glob"),
      namespace: "state",
      name: "glob",
      execute: async ({ pattern }, context: StateToolContext) =>
        await getStateRuntime(context).glob(pattern),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readJson"),
      namespace: "state",
      name: "readJson",
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readJson(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.writeJson"),
      namespace: "state",
      name: "writeJson",
      execute: async ({ path, value, options }, context: StateToolContext) => {
        await getStateRuntime(context).writeJson(path, value, options);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.applyEdits"),
      namespace: "state",
      name: "applyEdits",
      execute: async ({ edits }, context: StateToolContext) =>
        await getStateRuntime(context).applyEdits(edits),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.searchText"),
      namespace: "state",
      name: "searchText",
      execute: async ({ path, query, options }, context: StateToolContext) =>
        await getStateRuntime(context).searchText(path, query, options),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.searchFiles"),
      namespace: "state",
      name: "searchFiles",
      execute: async ({ pattern, keywords, options }, context: StateToolContext) =>
        await getStateRuntime(context).searchFiles(pattern, keywords, options),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.hashFile"),
      namespace: "state",
      name: "hashFile",
      execute: async ({ path, algorithm }, context: StateToolContext) =>
        await getStateRuntime(context).hashFile(path, algorithm),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.createDownloadLink"),
      namespace: "state",
      name: "createDownloadLink",
      getResource: ({ path }) => ({ path }),
      execute: async (input, context: StateToolContext) =>
        await getFileLinkRuntime(context).createDownloadLink(input),
      adapters: {
        bash: {
          command: "state.createDownloadLink",
          help: {
            summary: "Create a temporary URL that reads a workspace file, folder, or glob.",
            options: fileLinkHelpOptions,
            examples: ["state.createDownloadLink --path /workspace/data/"],
          },
          parse: parseFileLink("state.createDownloadLink"),
          format: (result, options) =>
            options.format === "json" ? { data: result } : { stdout: `${result.url}\n` },
        },
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.createUploadLink"),
      namespace: "state",
      name: "createUploadLink",
      getResource: ({ path }) => ({ path }),
      execute: async (input, context: StateToolContext) =>
        await getFileLinkRuntime(context).createUploadLink(input),
      adapters: {
        bash: {
          command: "state.createUploadLink",
          help: {
            summary: "Create a temporary URL that writes a workspace file, folder, or glob.",
            options: fileLinkHelpOptions,
            examples: ["state.createUploadLink --path /workspace/results/"],
          },
          parse: parseFileLink("state.createUploadLink"),
          format: (result, options) =>
            options.format === "json" ? { data: result } : { stdout: `${result.url}\n` },
        },
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.share"),
      namespace: "state",
      name: "share",
      getResource: ({ path }) => ({ path }),
      execute: async (input, context: StateToolContext) =>
        await getFileShareRuntime(context).share(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.acceptShare"),
      namespace: "state",
      name: "acceptShare",
      execute: async (input, context: StateToolContext) =>
        await getFileShareRuntime(context).accept(input),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.listShares"),
      namespace: "state",
      name: "listShares",
      execute: async (_input, context: StateToolContext) =>
        await getFileShareRuntime(context).list(),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.revokeShare"),
      namespace: "state",
      name: "revokeShare",
      execute: async (input, context: StateToolContext) => {
        await getFileShareRuntime(context).revoke(input);
      },
    }),
  ],
});

export const createCodemodeStateRuntime = (
  state: BackofficeStateBackend,
  options?: {
    context?: BackofficeToolContext;
  },
): ToolProvider => {
  const baseContext =
    options?.context ?? createTrustedSystemBackofficeToolContext({ runtimes: { state } });
  const context: StateToolContext = {
    ...baseContext,
    runtimes: { ...baseContext.runtimes, state },
  };
  const provider = createBackofficeCodemodeProviders({
    families: [codemodeStateToolFamily],
    context,
  }).at(0);
  if (!provider) {
    throw new Error("Codemode state runtime did not define a provider.");
  }
  return provider;
};
