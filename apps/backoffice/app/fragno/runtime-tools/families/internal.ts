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
import type { DurableHookQueueResponse } from "@/fragno/durable-hooks";
import { defineCliArgsParser, readOutputOptions } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { DurableHooksRuntime } from "./automations-durable-hooks";

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

type InternalToolContext = BackofficeToolContext<{
  internal?: InternalRuntime;
  durableHooks?: DurableHooksRuntime;
}>;

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

const durableHookRecordSchema = z.object({
  id: z.string(),
  hookName: z.string(),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  lastAttemptAt: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  error: z.string().nullable(),
  payload: z.unknown(),
});
const durableHookQueueResponseSchema = z.object({
  configured: z.boolean(),
  hooksEnabled: z.boolean(),
  namespace: z.string().nullable(),
  items: z.array(durableHookRecordSchema),
  cursor: z.string().optional(),
  hasNextPage: z.boolean(),
});

type InternalHooksListArgs = {
  fragment: string;
  cursor?: string;
  pageSize?: number;
};

type InternalHooksGetArgs = {
  fragment: string;
  hookId: string;
};

const getRuntime = (context: InternalToolContext) => {
  if (!context.runtimes.internal) {
    throw new Error("Internal runtime is not available in this execution context");
  }
  return context.runtimes.internal;
};

const getDurableHooksRuntime = (context: InternalToolContext) => {
  if (!context.runtimes.durableHooks) {
    throw new Error("Internal hooks runtime is not available in this execution context");
  }
  return context.runtimes.durableHooks;
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

const formatDurableHookQueue = (result: DurableHookQueueResponse, options: { format?: string }) => {
  if (options.format === "json") {
    return { data: result };
  }
  const lines = [
    `configured=${result.configured} hooksEnabled=${result.hooksEnabled} namespace=${result.namespace ?? "unavailable"}`,
    ...result.items.map(
      (item) =>
        `${item.id}\t${item.status}\t${item.hookName}\tattempts=${item.attempts}/${item.maxAttempts}`,
    ),
    ...(result.hasNextPage && result.cursor ? [`next cursor: ${result.cursor}`] : []),
  ];
  return { stdout: `${lines.join("\n")}\n` };
};

const formatDurableHookRecord = (
  result: DurableHookQueueResponse["items"][number] | null,
  options: { format?: string },
) => {
  if (options.format === "json") {
    return result ? { data: result } : { exitCode: 1 };
  }
  return result
    ? {
        stdout: `${result.id}\t${result.status}\t${result.hookName}\tattempts=${result.attempts}/${result.maxAttempts}\n`,
      }
    : { stderr: "Hook not found", exitCode: 1 };
};

const hooksListTool = defineBackofficeRuntimeTool({
  id: "internal.hooks.list",
  namespace: "internal",
  name: "hooksList",
  description: "List durable hook queue entries for a runtime fragment.",
  requiredPermissions: ["read"],
  inputSchema: z.object({
    fragment: z.string().trim().min(1),
    cursor: z.string().trim().min(1).optional(),
    pageSize: z.number().int().positive().optional(),
  }),
  outputSchema: durableHookQueueResponseSchema,
  execute: async (input, context: InternalToolContext) =>
    await getDurableHooksRuntime(context).listHooks(input),
  adapters: {
    bash: {
      command: "internal.hooks.list",
      help: {
        summary: "internal.hooks.list lists durable hook queue entries.",
        options: [
          {
            name: "fragment",
            required: true,
            valueRequired: true,
            valueName: "fragment",
            description: "Fragment scope, e.g. automations.",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Optional pagination cursor.",
          },
          {
            name: "page-size",
            valueRequired: true,
            valueName: "number",
            description: "Optional page size.",
          },
        ],
        examples: ["internal.hooks.list --fragment automations --page-size 50 --format json"],
      },
      parse: defineCliArgsParser<InternalHooksListArgs>("internal.hooks.list", {
        fragment: { required: true },
        cursor: {},
        pageSize: { kind: "positiveInteger" },
      }),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: formatDurableHookQueue,
    },
  },
});

const hooksGetTool = defineBackofficeRuntimeTool({
  id: "internal.hooks.get",
  namespace: "internal",
  name: "hooksGet",
  description: "Get a durable hook queue entry by id.",
  requiredPermissions: ["read"],
  inputSchema: z.object({ fragment: z.string().trim().min(1), hookId: z.string().trim().min(1) }),
  outputSchema: durableHookRecordSchema.nullable(),
  execute: async (input, context: InternalToolContext) =>
    await getDurableHooksRuntime(context).getHook(input),
  adapters: {
    bash: {
      command: "internal.hooks.get",
      help: {
        summary: "internal.hooks.get returns one durable hook entry by id.",
        options: [
          {
            name: "fragment",
            required: true,
            valueRequired: true,
            valueName: "fragment",
            description: "Fragment scope.",
          },
          {
            name: "hook-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Durable hook id.",
          },
        ],
        examples: ["internal.hooks.get --fragment automations --hook-id hook_123 --format json"],
      },
      parse: defineCliArgsParser<InternalHooksGetArgs>("internal.hooks.get", {
        fragment: { required: true },
        hookId: { required: true },
      }),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: formatDurableHookRecord,
    },
  },
});

const internalRuntimeTools = [
  filesSeedExecuteTool,
  projectFilesConfigureTool,
  automationRoutesSeedStarterTool,
  hooksListTool,
  hooksGetTool,
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
