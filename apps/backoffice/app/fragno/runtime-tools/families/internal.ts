import { z } from "zod";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { FileSystemError } from "@/files/fs-errors";
import { createMasterFileSystem } from "@/files/master-file-system";
import {
  seedWorkspaceStarterFiles,
  type WorkspaceStarterFilesSeedOutput,
} from "@/files/seed-workspace-starter-files";
import { createSystemFilesContext } from "@/files/system-context";
import type { StarterAutomationRoutesSeedResult } from "@/fragno/automation";
import { defineCliArgsParser, readOutputOptions } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type ProjectDatabaseFileSystemConfigureOutput = {
  projectId: string;
  provider: "database";
  configured: boolean;
  created: string[];
  skipped: string[];
};

export type InternalRuntime = {
  seedWorkspaceStarterFiles(input?: { force?: boolean }): Promise<WorkspaceStarterFilesSeedOutput>;
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

export const createInternalRuntime = ({
  objects,
  config: _config,
  orgId,
  origin = "https://backoffice.local",
  families: _families,
}: {
  objects: BackofficeObjectRegistry;
  config: BackofficeRuntimeConfig;
  orgId: string;
  origin?: string;
  families: readonly BackofficeRuntimeToolFamily[];
}): InternalRuntime => {
  return {
    seedWorkspaceStarterFiles: async (input) =>
      await seedWorkspaceStarterFiles({ objects, orgId, force: input?.force }),
    seedStarterAutomationRoutes: async () =>
      await objects.automations.forOrg(orgId).seedStarterAutomationRoutes(),
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
          staticFileArtifacts: () => ({}),
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

const internalRuntimeTools = [
  filesSeedExecuteTool,
  projectFilesConfigureTool,
  automationRoutesSeedStarterTool,
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
