import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { createMasterFileSystem, createSystemFilesContext } from "@/files";
import type { IFileSystem } from "@/files/interface";
import {
  seedWorkspaceStarterFiles,
  type WorkspaceStarterFilesSeedOutput,
} from "@/files/seed-workspace-starter-files";
import {
  backofficeCapabilities,
  type BackofficeCapabilityId,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { CODEMODE_DTS_PATH, createCodemodeDts } from "@/fragno/codemode/codemode-dts";
import { createMcpCodemodeServers } from "@/fragno/codemode/mcp-codemode-tools";
import { STATE_TYPES } from "@/fragno/codemode/state-prompt";
import { defineCliArgsParser, readOutputOptions } from "@/fragno/runtime-tools/bash-cli";
import { createMcpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type CodemodeTypesSyncOutput = {
  path: typeof CODEMODE_DTS_PATH;
  changed: boolean;
  configuredCapabilities: BackofficeCapabilityId[];
};

export type InternalRuntime = {
  seedWorkspaceStarterFiles(input?: { force?: boolean }): Promise<WorkspaceStarterFilesSeedOutput>;
  syncCodemodeTypes(): Promise<CodemodeTypesSyncOutput>;
};

type InternalToolContext = BackofficeToolContext<{ internal?: InternalRuntime }>;

const workspaceStarterFilesSeedOutputSchema = z.object({
  provider: z.string(),
  force: z.boolean(),
  created: z.array(z.string()),
  overwritten: z.array(z.string()),
  skipped: z.array(z.string()),
});

const codemodeTypesSyncOutputSchema = z.object({
  path: z.literal(CODEMODE_DTS_PATH),
  changed: z.boolean(),
  configuredCapabilities: z.array(z.string()),
});

const getRuntime = (context: InternalToolContext) => {
  if (!context.runtimes.internal) {
    throw new Error("Internal runtime is not available in this execution context");
  }
  return context.runtimes.internal;
};

export const createInternalRuntime = ({
  objects,
  config,
  orgId,
  origin = "https://backoffice.local",
  families,
  fileSystem,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  orgId: string;
  origin?: string;
  families: readonly BackofficeRuntimeToolFamily[];
  fileSystem?: IFileSystem;
}): InternalRuntime => {
  const renderCodemodeTypes = async (): Promise<{
    path: typeof CODEMODE_DTS_PATH;
    content: string;
    configuredCapabilities: BackofficeCapabilityId[];
  }> => {
    const configuredCapabilities: BackofficeCapabilityId[] = [];

    for (const capability of backofficeCapabilities) {
      if (capability.kind === "system") {
        configuredCapabilities.push(capability.id);
        continue;
      }

      const status = await capability.connection.getStatus({ objects, config, orgId, origin });
      if (status.configured) {
        configuredCapabilities.push(capability.id);
      }
    }

    const mcpServers = configuredCapabilities.includes("mcp")
      ? await createMcpRuntime(objects.mcp.forOrg(orgId))
          .listServers()
          .then(({ servers }) => createMcpCodemodeServers(servers))
      : [];

    return {
      path: CODEMODE_DTS_PATH,
      content: createCodemodeDts({
        configuredCapabilityIds: configuredCapabilities,
        families,
        mcpServers,
        stateTypes: STATE_TYPES,
      }),
      configuredCapabilities,
    };
  };

  return {
    seedWorkspaceStarterFiles: async (input) =>
      await seedWorkspaceStarterFiles({ objects, orgId, force: input?.force }),
    syncCodemodeTypes: async () => {
      const rendered = await renderCodemodeTypes();
      let fs = fileSystem;
      let existing: string | null = null;

      if (fs) {
        try {
          existing = (await fs.exists(rendered.path)) ? await fs.readFile(rendered.path) : null;
        } catch {
          fs = undefined;
        }
      }

      if (!fs) {
        fs = await createMasterFileSystem(createSystemFilesContext({ objects, orgId, origin }));
        existing = (await fs.exists(rendered.path)) ? await fs.readFile(rendered.path) : null;
      }
      const changed = existing !== rendered.content;

      if (changed) {
        try {
          await fs.writeFile(rendered.path, rendered.content);
        } catch (error) {
          if (!fileSystem || fs !== fileSystem) {
            throw error;
          }

          fs = await createMasterFileSystem(createSystemFilesContext({ objects, orgId, origin }));
          existing = (await fs.exists(rendered.path)) ? await fs.readFile(rendered.path) : null;
          if (existing !== rendered.content) {
            await fs.writeFile(rendered.path, rendered.content);
          }
        }
      }

      return {
        path: rendered.path,
        changed,
        configuredCapabilities: rendered.configuredCapabilities,
      };
    },
  };
};

const filesSeedExecuteTool = defineBackofficeRuntimeTool({
  id: "internal.files.seed.execute",
  namespace: "internal",
  name: "filesSeedExecute",
  description: "Seed the org workspace with starter files if they do not already exist.",
  requiredPermissions: ["manage"],
  inputSchema: z.object({ force: z.boolean().optional() }),
  outputSchema: workspaceStarterFilesSeedOutputSchema,
  execute: async (input, context: InternalToolContext) =>
    await getRuntime(context).seedWorkspaceStarterFiles(input),
  adapters: {
    bash: {
      command: "internal.files.seed.execute",
      help: {
        summary: "internal.files.seed.execute seeds missing workspace starter files.",
        options: [
          {
            name: "force",
            description: "Replace starter files and repair starter file/folder permissions.",
          },
        ],
        examples: [
          "internal.files.seed.execute --format json",
          "internal.files.seed.execute --force",
        ],
      },
      parse: defineCliArgsParser<{ force?: boolean }>("internal.files.seed.execute", {
        force: { kind: "boolean" },
      }),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: (output, options) =>
        options.format === "json" || options.print
          ? { data: output }
          : {
              stdout: `provider=${output.provider}\nforce=${output.force ? "yes" : "no"}\ncreated=${output.created.length}\noverwritten=${output.overwritten.length}\nskipped=${output.skipped.length}\n`,
            },
    },
  },
});

const codemodeTypesSyncTool = defineBackofficeRuntimeTool({
  id: "internal.codemode.types.sync",
  namespace: "internal",
  name: "codemodeTypesSync",
  description: "Render and write the org-scoped codemode TypeScript declarations if changed.",
  requiredPermissions: ["manage"],
  inputSchema: z.object({}).optional().default({}),
  outputSchema: codemodeTypesSyncOutputSchema,
  execute: async (_input, context: InternalToolContext) =>
    await getRuntime(context).syncCodemodeTypes(),
  adapters: {
    bash: {
      command: "internal.codemode.types.sync",
      help: {
        summary: "internal.codemode.types.sync writes /workspace/codemode.d.ts if changed.",
        options: [],
        examples: ["internal.codemode.types.sync --format json"],
      },
      parse: () => ({}),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: (output, options) =>
        options.format === "json" || options.print
          ? { data: output }
          : {
              stdout: `path=${output.path}\nchanged=${output.changed ? "yes" : "no"}\nconfiguredCapabilities=${output.configuredCapabilities.join(",")}\n`,
            },
    },
  },
});

const internalRuntimeTools = [filesSeedExecuteTool, codemodeTypesSyncTool] as const;

export const internalToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "internal",
  permissions: {
    read: "Read internal runtime generated artifacts.",
    manage: "Run internal runtime maintenance tasks.",
  },
  tools: internalRuntimeTools,
  hidden: true,
  isAvailable: (context: InternalToolContext) => !!context.runtimes.internal,
});
