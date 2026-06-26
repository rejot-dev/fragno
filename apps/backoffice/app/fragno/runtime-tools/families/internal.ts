import { z } from "zod";

import { SYSTEM_BACKOFFICE_PRINCIPAL } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { createBackofficeFileSystem } from "@/files/create-file-system";
import { FileSystemError } from "@/files/fs-errors";
import type { IFileSystem } from "@/files/interface";
import { createMasterFileSystem } from "@/files/master-file-system";
import {
  seedWorkspaceStarterFiles,
  type WorkspaceStarterFilesSeedOutput,
} from "@/files/seed-workspace-starter-files";
import { createSystemFilesContext } from "@/files/system-context";
import type { StarterAutomationRoutesSeedResult } from "@/fragno/automation";
import {
  backofficeCapabilities,
  type BackofficeCapabilityId,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  CODEMODE_PROVIDER_TYPES_DIR_PATH,
  CODEMODE_SYSTEM_DTS_PATH,
  CODEMODE_TYPES_DIR_PATH,
  createCodemodeTypeFiles,
  type CodemodeTypeFile,
} from "@/fragno/codemode/codemode-dts";
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
  path: typeof CODEMODE_SYSTEM_DTS_PATH;
  changed: boolean;
  configuredCapabilities: BackofficeCapabilityId[];
};

export type ProjectDatabaseFileSystemConfigureOutput = {
  projectId: string;
  provider: "database";
  configured: boolean;
  created: string[];
  skipped: string[];
};

export type InternalRuntime = {
  seedWorkspaceStarterFiles(input?: { force?: boolean }): Promise<WorkspaceStarterFilesSeedOutput>;
  syncCodemodeTypes(): Promise<CodemodeTypesSyncOutput>;
  configureProjectDatabaseFileSystem(input: {
    projectId: string;
  }): Promise<ProjectDatabaseFileSystemConfigureOutput>;
  seedStarterAutomationRoutes(): Promise<StarterAutomationRoutesSeedResult>;
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
  path: z.literal(CODEMODE_SYSTEM_DTS_PATH),
  changed: z.boolean(),
  configuredCapabilities: z.array(z.string()),
});

const projectDatabaseFileSystemConfigureOutputSchema = z.object({
  projectId: z.string(),
  provider: z.literal("database"),
  configured: z.boolean(),
  created: z.array(z.string()),
  skipped: z.array(z.string()),
});

const starterAutomationRoutesSeedOutputSchema = z.object({
  created: z.array(z.string()),
  skipped: z.array(z.string()),
});

const getRuntime = (context: InternalToolContext) => {
  if (!context.runtimes.internal) {
    throw new Error("Internal runtime is not available in this execution context");
  }
  return context.runtimes.internal;
};

const ensureDirectory = async (fs: IFileSystem, path: string) => {
  if (await fs.exists(path)) {
    const stat = await fs.stat(path);
    if (!stat.isDirectory) {
      throw new Error(`Codemode types path exists but is not a directory: ${path}`);
    }
    return;
  }

  await fs.mkdir(path, { recursive: true });
};

const syncCodemodeTypeFiles = async (
  fs: IFileSystem,
  files: readonly CodemodeTypeFile[],
): Promise<boolean> => {
  await ensureDirectory(fs, CODEMODE_TYPES_DIR_PATH);
  await ensureDirectory(fs, CODEMODE_PROVIDER_TYPES_DIR_PATH);

  const expectedPaths = new Set(files.map((file) => file.path));
  let changed = false;

  for (const name of await fs.readdir(CODEMODE_PROVIDER_TYPES_DIR_PATH)) {
    const path = `${CODEMODE_PROVIDER_TYPES_DIR_PATH}/${name}`;
    if (!name.endsWith(".d.ts") || expectedPaths.has(path)) {
      continue;
    }
    await fs.rm(path, { force: true });
    changed = true;
  }

  for (const file of files) {
    const existing = (await fs.exists(file.path)) ? await fs.readFile(file.path) : null;
    if (existing === file.content) {
      continue;
    }
    await fs.writeFile(file.path, file.content);
    changed = true;
  }

  return changed;
};

export const createInternalRuntime = ({
  objects,
  config,
  orgId,
  origin = "https://backoffice.local",
  families,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  orgId: string;
  origin?: string;
  families: readonly BackofficeRuntimeToolFamily[];
}): InternalRuntime => {
  const renderCodemodeTypes = async (): Promise<{
    path: typeof CODEMODE_SYSTEM_DTS_PATH;
    files: CodemodeTypeFile[];
    configuredCapabilities: BackofficeCapabilityId[];
  }> => {
    const configuredCapabilities: BackofficeCapabilityId[] = [];

    for (const capability of backofficeCapabilities) {
      if (capability.kind === "system") {
        configuredCapabilities.push(capability.id);
        continue;
      }

      const status = await capability.connection.getStatus({
        objects,
        config,
        scope: { kind: "org", orgId },
        orgId,
        origin,
      });
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
      path: CODEMODE_SYSTEM_DTS_PATH,
      files: createCodemodeTypeFiles({
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
    seedStarterAutomationRoutes: async () =>
      await objects.automations
        .forOrg(orgId)
        .seedStarterAutomationRoutes({ scope: { kind: "org", orgId } }),
    configureProjectDatabaseFileSystem: async ({ projectId }) => {
      const uploadObject = objects.upload.forProject({ orgId, projectId });
      const config = await uploadObject.setAdminConfig(
        { provider: "database", defaultProvider: "database" },
        orgId,
        origin,
      );
      const fs = await createMasterFileSystem(
        createSystemFilesContext({
          objects,
          execution: {
            actor: { type: "system", id: "backoffice-project-files" },
            scope: { kind: "project", orgId, projectId },
          },
        }),
      );
      const created: string[] = [];
      const skipped: string[] = [];
      const readmePath = "/workspace/README.md";
      try {
        await fs.readFileBuffer(readmePath);
        skipped.push(readmePath);
      } catch (error) {
        if (!(error instanceof FileSystemError) || error.code !== "ENOENT") {
          throw error;
        }
        await fs.writeFile(
          readmePath,
          `# Project workspace\n\nThis is the db-backed workspace for project ${projectId}.\n`,
        );
        created.push(readmePath);
      }

      return {
        projectId,
        provider: "database",
        configured: config.providers.database?.configured === true,
        created,
        skipped,
      };
    },
    syncCodemodeTypes: async () => {
      const rendered = await renderCodemodeTypes();
      const kernel = new BackofficeKernel({ objects });
      const fs = await createBackofficeFileSystem({
        objects,
        kernel,
        execution: {
          actor: SYSTEM_BACKOFFICE_PRINCIPAL,
          scope: { kind: "org", orgId },
        },
      });
      const changed = await syncCodemodeTypeFiles(fs, rendered.files);

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

const projectFilesConfigureTool = defineBackofficeRuntimeTool({
  id: "internal.project.files.configure",
  namespace: "internal",
  name: "projectFilesConfigure",
  description: "Configure a project-scoped database-backed workspace filesystem.",
  requiredPermissions: ["manage"],
  inputSchema: z.object({ projectId: z.string().trim().min(1) }),
  outputSchema: projectDatabaseFileSystemConfigureOutputSchema,
  execute: async (input, context: InternalToolContext) =>
    await getRuntime(context).configureProjectDatabaseFileSystem(input),
  adapters: {
    bash: {
      command: "internal.project.files.configure",
      help: {
        summary: "internal.project.files.configure configures a db-backed project workspace.",
        options: [{ name: "projectId", description: "Project id to configure." }],
        examples: ["internal.project.files.configure --projectId project_123 --format json"],
      },
      parse: defineCliArgsParser<{ projectId: string }>("internal.project.files.configure", {
        projectId: { required: true },
      }),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: (output, options) =>
        options.format === "json" || options.print
          ? { data: output }
          : {
              stdout: `projectId=${output.projectId}\nprovider=${output.provider}\nconfigured=${output.configured ? "yes" : "no"}\ncreated=${output.created.length}\nskipped=${output.skipped.length}\n`,
            },
    },
  },
});

const automationRoutesSeedStarterTool = defineBackofficeRuntimeTool({
  id: "internal.automations.routes.seed-starter",
  namespace: "internal",
  name: "automationsRoutesSeedStarter",
  description: "Seed the default database-backed automation routes.",
  requiredPermissions: ["manage"],
  inputSchema: z.object({}).optional().default({}),
  outputSchema: starterAutomationRoutesSeedOutputSchema,
  execute: async (_input, context: InternalToolContext) =>
    await getRuntime(context).seedStarterAutomationRoutes(),
  adapters: {
    bash: {
      command: "internal.automations.routes.seed-starter",
      help: {
        summary:
          "internal.automations.routes.seed-starter seeds the default automation route rows.",
        options: [],
        examples: ["internal.automations.routes.seed-starter --format json"],
      },
      parse: defineCliArgsParser<Record<string, never>>(
        "internal.automations.routes.seed-starter",
        {},
      ),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: (output, options) =>
        options.format === "json" || options.print
          ? { data: output }
          : {
              stdout: `created=${output.created.length}\nskipped=${output.skipped.length}\n`,
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
        summary: "internal.codemode.types.sync writes /workspace/codemode/system.d.ts if changed.",
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

const internalRuntimeTools = [
  filesSeedExecuteTool,
  projectFilesConfigureTool,
  automationRoutesSeedStarterTool,
  codemodeTypesSyncTool,
] as const;

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
