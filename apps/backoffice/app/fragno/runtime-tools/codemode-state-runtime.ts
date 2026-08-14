import { z } from "zod";

import type { ToolProvider } from "@/fragno/codemode/runtime-api";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { jsonValueSchema } from "@/lib/zod/json-value";

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

const pathInputSchema = z.strictObject({
  path: z.string(),
});
const bytesSchema = z
  .custom<Uint8Array>((value) => value instanceof Uint8Array, "Expected Uint8Array")
  .meta({ codemodeType: "Uint8Array" });
const fileSearchOptionsSchema = z.strictObject({
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  contextBefore: z.number().optional(),
  contextAfter: z.number().optional(),
  maxMatches: z.number().optional(),
});
const mountFileSearchOptionsSchema = fileSearchOptionsSchema.extend({
  cursor: z.string().optional(),
});
const fileSearchOptionsByMountSchema = z.strictObject({
  upload: mountFileSearchOptionsSchema.optional(),
  static: mountFileSearchOptionsSchema.optional(),
});
const textSearchOptionsSchema = fileSearchOptionsSchema.extend({
  regex: z.boolean().optional(),
});
const fileEditSearchOptionsSchema = z.strictObject({
  caseSensitive: z.boolean().optional(),
  regex: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  maxMatches: z.number().optional(),
});
const fileEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("write"),
    path: z.string(),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal("replace"),
    path: z.string(),
    search: z.string(),
    replacement: z.string(),
    options: fileEditSearchOptionsSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("writeJson"),
    path: z.string(),
    value: jsonValueSchema,
    options: z.strictObject({ spaces: z.number().optional() }).optional(),
  }),
]);
const appliedFileEditSchema = z.strictObject({
  path: z.string(),
  changed: z.boolean(),
  content: z.string(),
  diff: z.string(),
});
const statOutputSchema = z
  .strictObject({
    type: z.enum(["file", "directory"]),
    size: z.number(),
    mtime: z.date(),
    mode: z.number().optional(),
  })
  .nullable();
const textMatchSchema = z.strictObject({
  line: z.number(),
  column: z.number(),
  match: z.string(),
  lineText: z.string(),
  beforeLines: z.array(z.string()).optional(),
  afterLines: z.array(z.string()).optional(),
});
const fileSearchPageSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      path: z.string(),
      matches: z.array(textMatchSchema),
    }),
  ),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
});

export const codemodeStateToolFamily = defineBackofficeRuntimeToolFamily<StateToolContext>({
  namespace: "state",
  permissions: {
    read: "Read files in the current execution scope.",
    modify: "Modify files in the current execution scope.",
  },
  isAvailable: (context) => Boolean(context.runtimes.state),
  tools: [
    defineBackofficeRuntimeTool({
      id: "state.readFile",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readFile",
      description: "Read a UTF-8 text file from codemode state.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: z.string(),
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
      id: "state.writeFile",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "writeFile",
      description: "Write a UTF-8 text file to mutable codemode state.",
      requiredPermissions: ["modify"],
      inputSchema: z.strictObject({
        path: z.string(),
        content: z.string(),
      }),
      outputSchema: z.void(),
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
      id: "state.exists",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "exists",
      description: "Check whether a codemode state path exists.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: z.boolean(),
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).exists(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.stat",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "stat",
      description: "Read metadata for a codemode state path.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: statOutputSchema,
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).stat(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.lstat",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "lstat",
      description: "Read metadata for a codemode state path without following links.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: statOutputSchema,
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).lstat(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.mkdir",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "mkdir",
      description: "Create a directory in mutable codemode state.",
      requiredPermissions: ["modify"],
      inputSchema: pathInputSchema,
      outputSchema: z.void(),
      execute: async ({ path }, context: StateToolContext) => {
        await getStateRuntime(context).mkdir(path);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.readdir",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readdir",
      description: "List the names directly below a codemode state directory.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: z.array(z.string()),
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readdir(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.readdirWithFileTypes",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readdirWithFileTypes",
      description: "List names and entry types directly below a codemode state directory.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: z.array(
        z.strictObject({
          name: z.string(),
          type: z.enum(["file", "directory"]),
        }),
      ),
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readdirWithFileTypes(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.rm",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "rm",
      description: "Remove a file or empty directory from mutable codemode state.",
      requiredPermissions: ["modify"],
      inputSchema: z.strictObject({
        path: z.string(),
        options: z
          .strictObject({
            force: z.boolean().optional(),
          })
          .optional(),
      }),
      outputSchema: z.void(),
      execute: async ({ path, options }, context: StateToolContext) => {
        await getStateRuntime(context).rm(path, options);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.cp",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "cp",
      description: "Copy one file within mutable codemode state.",
      requiredPermissions: ["read", "modify"],
      inputSchema: z.strictObject({
        src: z.string(),
        dest: z.string(),
      }),
      outputSchema: z.void(),
      execute: async ({ src, dest }, context: StateToolContext) => {
        await getStateRuntime(context).cp(src, dest);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.mv",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "mv",
      description: "Move one file within mutable codemode state.",
      requiredPermissions: ["read", "modify"],
      inputSchema: z.strictObject({
        src: z.string(),
        dest: z.string(),
      }),
      outputSchema: z.void(),
      execute: async ({ src, dest }, context: StateToolContext) => {
        await getStateRuntime(context).mv(src, dest);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.realpath",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "realpath",
      description: "Resolve and validate a codemode state path.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: z.string(),
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).realpath(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.resolvePath",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "resolvePath",
      description: "Resolve a path against a base path without accessing storage.",
      requiredPermissions: [],
      inputSchema: z.strictObject({
        base: z.string(),
        path: z.string(),
      }),
      outputSchema: z.string(),
      execute: async ({ base, path }, context: StateToolContext) =>
        getStateRuntime(context).resolvePath(base, path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.glob",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "glob",
      description: "Find codemode state paths matching a glob pattern.",
      requiredPermissions: ["read"],
      inputSchema: z.strictObject({
        pattern: z.string(),
      }),
      outputSchema: z.array(z.string()),
      execute: async ({ pattern }, context: StateToolContext) =>
        await getStateRuntime(context).glob(pattern),
    }),
    defineBackofficeRuntimeTool({
      id: "state.readJson",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "readJson",
      description: "Read and parse a JSON file from codemode state.",
      requiredPermissions: ["read"],
      inputSchema: pathInputSchema,
      outputSchema: jsonValueSchema,
      execute: async ({ path }, context: StateToolContext) =>
        await getStateRuntime(context).readJson(path),
    }),
    defineBackofficeRuntimeTool({
      id: "state.writeJson",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "writeJson",
      description: "Serialize and write a JSON value to mutable codemode state.",
      requiredPermissions: ["modify"],
      inputSchema: z.strictObject({
        path: z.string(),
        value: jsonValueSchema,
        options: z
          .strictObject({
            spaces: z.number().optional(),
          })
          .optional(),
      }),
      outputSchema: z.void(),
      execute: async ({ path, value, options }, context: StateToolContext) => {
        await getStateRuntime(context).writeJson(path, value, options);
      },
    }),
    defineBackofficeRuntimeTool({
      id: "state.applyEdits",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "applyEdits",
      description: "Atomically apply text and JSON edits to mutable codemode state files.",
      requiredPermissions: ["modify"],
      inputSchema: z.strictObject({
        edits: z.array(fileEditSchema),
      }),
      outputSchema: z.strictObject({
        edits: z.array(appliedFileEditSchema),
        totalChanged: z.number(),
      }),
      execute: async ({ edits }, context: StateToolContext) =>
        await getStateRuntime(context).applyEdits(edits),
    }),
    defineBackofficeRuntimeTool({
      id: "state.searchText",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "searchText",
      description: "Search for text within one codemode state file.",
      requiredPermissions: ["read"],
      inputSchema: z.strictObject({
        path: z.string(),
        query: z.string(),
        options: textSearchOptionsSchema.optional(),
      }),
      outputSchema: z.array(textMatchSchema),
      execute: async ({ path, query, options }, context: StateToolContext) =>
        await getStateRuntime(context).searchText(path, query, options),
    }),
    defineBackofficeRuntimeTool({
      id: "state.searchFiles",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "searchFiles",
      description: "Search for text across codemode state files matching a glob pattern.",
      requiredPermissions: ["read"],
      inputSchema: z.strictObject({
        pattern: z.string(),
        query: z.string(),
        options: fileSearchOptionsByMountSchema.optional(),
      }),
      outputSchema: z.strictObject({
        upload: fileSearchPageSchema,
        static: fileSearchPageSchema,
      }),
      execute: async ({ pattern, query, options }, context: StateToolContext) =>
        await getStateRuntime(context).searchFiles(pattern, query, options),
    }),
    defineBackofficeRuntimeTool({
      id: "state.hashFile",
      namespace: "state",
      authorizationNamespace: "upload",
      name: "hashFile",
      description: "Hash the bytes of one codemode state file.",
      requiredPermissions: ["read"],
      inputSchema: z.strictObject({
        path: z.string(),
        algorithm: z.enum(["md5", "sha1", "sha256"]).default("sha256"),
      }),
      outputSchema: z.string(),
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
