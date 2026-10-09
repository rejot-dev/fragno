import { pathInputSchema } from "@fragno-dev/backoffice-api/v0/state";
import type { ToolProvider } from "@fragno-dev/codemode/runtime-api";
import { z } from "zod";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { backofficeApiOperationToolFields } from "@/fragno/runtime-tools/runtime-tools";

import {
  createBackofficeCodemodeProviders,
  createTrustedSystemBackofficeToolContext,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeToolCall,
  type BackofficeToolContext,
} from "./runtime-tools";

export type StateToolContext = BackofficeToolContext<
  Record<string, unknown> & { state?: BackofficeStateBackend }
>;

const getStateRuntime = (context: StateToolContext): BackofficeStateBackend => {
  if (!context.runtimes.state) {
    throw new Error("State is not available in this execution context.");
  }
  return context.runtimes.state;
};

const bytesSchema = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array, "Expected Uint8Array")
  .meta({ codemodeType: "Uint8Array" });
export const codemodeStateToolFamily = defineBackofficeRuntimeToolFamily<StateToolContext>({
  namespace: "state",
  permissions: {
    read: "Read files in the current execution scope.",
    modify: "Modify files in the current execution scope.",
  },
  isAvailable: (context) => Boolean(context.runtimes.state),
  tools: [
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readFile"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readFile",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readFile(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.readFileBytes",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readFileBytes",
      description: "Read a file from codemode state as bytes.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: bytesSchema,
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readFileBytes(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.writeFile"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "writeFile",
      requiredPermissions: ["modify"],
      execute: async ({ path, content }, context: StateToolContext) => {
        await getStateRuntime(context).writeFile(path, content);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.writeFileBytes",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "writeFileBytes",
      description: "Write bytes to mutable codemode state.",
      requiredPermissions: ["modify"],
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
      authorizationNamespace: "upload",
      name: "appendFile",
      description: "Append text or bytes to a file in mutable codemode state.",
      requiredPermissions: ["modify"],
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
      authorizationNamespace: "upload",
      name: "exists",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).exists(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.stat"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "stat",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).stat(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.lstat"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "lstat",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).lstat(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.mkdir"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "mkdir",
      requiredPermissions: ["modify"],
      execute: async ({ path }, context: StateToolContext) => {
        await getStateRuntime(context).mkdir(path);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readdir"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readdir",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readdir(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readdirWithFileTypes"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readdirWithFileTypes",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readdirWithFileTypes(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.rm"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "rm",
      requiredPermissions: ["modify"],
      execute: async ({ path, options }, context: StateToolContext) => {
        await getStateRuntime(context).rm(path, options);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.cp"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "cp",
      requiredPermissions: ["read", "modify"],
      execute: async ({ src, dest }, context: StateToolContext) => {
        await getStateRuntime(context).cp(src, dest);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.mv"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "mv",
      requiredPermissions: ["read", "modify"],
      execute: async ({ src, dest }, context: StateToolContext) => {
        await getStateRuntime(context).mv(src, dest);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.realpath"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "realpath",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).realpath(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.resolvePath"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "resolvePath",
      requiredPermissions: [],
      execute: async ({ base, path }, context: StateToolContext) =>
        getStateRuntime(context).resolvePath(base, path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.glob"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "glob",
      requiredPermissions: ["read"],
      execute: async ({ pattern }, context: StateToolContext) =>
        await getStateRuntime(context).glob(pattern),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.readJson"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readJson",
      requiredPermissions: ["read"],
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readJson(path),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.writeJson"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "writeJson",
      requiredPermissions: ["modify"],
      execute: async ({ path, value, options }, context: StateToolContext) => {
        await getStateRuntime(context).writeJson(path, value, options);
      },
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.applyEdits"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "applyEdits",
      requiredPermissions: ["modify"],
      execute: async ({ edits }, context: StateToolContext) =>
        await getStateRuntime(context).applyEdits(edits),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.searchText"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "searchText",
      requiredPermissions: ["read"],
      execute: async ({ path, query, options }, context: StateToolContext) =>
        await getStateRuntime(context).searchText(path, query, options),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.searchFiles"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "searchFiles",
      requiredPermissions: ["read"],
      execute: async ({ pattern, query, options }, context: StateToolContext) =>
        await getStateRuntime(context).searchFiles(pattern, query, options),
    }),
    defineBackofficeRuntimeTool({
      ...backofficeApiOperationToolFields("state.hashFile"),
      namespace: "state",
      authorizationNamespace: "upload",
      name: "hashFile",
      requiredPermissions: ["read"],
      execute: async ({ path, algorithm }, context: StateToolContext) =>
        await getStateRuntime(context).hashFile(path, algorithm),
    }),
  ],
});

export const createCodemodeStateRuntime = (
  state: BackofficeStateBackend,
  options?: {
    context?: BackofficeToolContext;
    toolCalls?: BackofficeRuntimeToolCall[];
  },
): ToolProvider => {
  const baseContext =
    options?.context ?? createTrustedSystemBackofficeToolContext({ runtimes: { state } });
  const context: StateToolContext = {
    ...baseContext,
    runtimes: { ...baseContext.runtimes, state },
  };
  const provider = createBackofficeCodemodeProviders({
    tools: codemodeStateToolFamily.tools,
    context,
    ...(options?.toolCalls ? { toolCalls: options.toolCalls } : {}),
  }).at(0);
  if (!provider) {
    throw new Error("Codemode state runtime did not define a provider.");
  }
  return provider;
};
