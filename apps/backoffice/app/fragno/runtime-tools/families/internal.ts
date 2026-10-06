import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import {
  seedWorkspaceStarterFiles,
  type WorkspaceStarterFilesSeedOutput,
} from "@/files/seed-workspace-starter-files";
import {
  marketplaceStaticPublicationResultSchema,
  type MarketplaceStaticPublicationResult,
} from "@/fragno/marketplace/contracts";
import type {
  AutomationCommandExecutionResult,
  AutomationCommandOutputOptions,
} from "@/fragno/runtime-tools/automation-types";
import { defineCliArgsParser, readOutputOptions } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type InternalRuntime =
  | {
      kind: "org";
      seedWorkspaceStarterFiles(input?: {
        force?: boolean;
      }): Promise<WorkspaceStarterFilesSeedOutput>;
    }
  | {
      kind: "system";
      pushStaticMarketplaceEntries(input?: {
        force?: boolean;
      }): Promise<MarketplaceStaticPublicationResult>;
    };

type InternalToolContext = BackofficeToolContext<{
  internal?: InternalRuntime;
}>;

const workspaceStarterFilesSeedOutputSchema = z.object({
  provider: z.string(),
  force: z.boolean(),
  created: z.array(z.string()),
  overwritten: z.array(z.string()),
  skipped: z.array(z.string()),
});

function getRuntime(context: InternalToolContext) {
  if (!context.runtimes.internal) {
    throw new Error("Internal runtime is not available in this execution context");
  }
  return context.runtimes.internal;
}

/** Workspace maintenance belongs to the organization; bundled marketplace publication belongs to System. */
export function createInternalRuntime({
  objects,
  scope,
}: {
  objects: BackofficeObjectRegistry;
  scope: Extract<BackofficeContextScope, { kind: "system" | "org" }>;
}): InternalRuntime {
  if (scope.kind === "org") {
    return {
      kind: "org",
      seedWorkspaceStarterFiles: async (input) =>
        await seedWorkspaceStarterFiles({ objects, scope, force: input?.force }),
    };
  }
  return {
    kind: "system",
    pushStaticMarketplaceEntries: async (input) =>
      await objects.automations.singleton().commands.requestStaticMarketplacePublications(input),
  };
}

const filesSeedExecuteTool = defineBackofficeRuntimeTool({
  id: "internal.files.seed.execute",
  namespace: "internal",
  name: "filesSeedExecute",
  description: "Seed the org workspace with starter files if they do not already exist.",
  requiredPermissions: ["manage"],
  inputSchema: z.object({ force: z.boolean().optional() }),
  outputSchema: workspaceStarterFilesSeedOutputSchema,
  execute: async (input, context: InternalToolContext) => {
    const runtime = getRuntime(context);
    if (runtime.kind !== "org") {
      throw new Error("Workspace starter file seeding requires an organization context.");
    }
    return await runtime.seedWorkspaceStarterFiles(input);
  },
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

export function formatMarketplacePushOutput(
  output: MarketplaceStaticPublicationResult,
  options: AutomationCommandOutputOptions,
): AutomationCommandExecutionResult<MarketplaceStaticPublicationResult> {
  const failures = output.publications.filter((publication) => publication.state === "failed");
  if (options.format === "json" || options.print) {
    return {
      data: output,
      ...(failures.length > 0 ? { exitCode: 1 } : {}),
    };
  }

  const stdout = `${output.publications
    .map(
      (publication) =>
        `${publication.state}\t${publication.listingId}@${publication.version}\t${publication.state === "published" ? "" : publication.workflowInstanceId}`,
    )
    .join("\n")}\n`;
  if (failures.length === 0) {
    return { stdout };
  }

  return {
    stdout,
    stderr: `${failures
      .map(
        (publication) =>
          `${publication.listingId}@${publication.version}: ${publication.error.name}: ${publication.error.message}`,
      )
      .join("\n")}\n`,
    exitCode: 1,
  };
}

const marketplacePushTool = defineBackofficeRuntimeTool({
  id: "internal.marketplace.push",
  namespace: "internal",
  name: "marketplacePush",
  description: "Publish the bundled static marketplace entries from System context.",
  requiredPermissions: ["manage"],
  inputSchema: z.object({ force: z.boolean().optional() }).optional().default({}),
  outputSchema: marketplaceStaticPublicationResultSchema,
  execute: async (input, context: InternalToolContext) => {
    if (context.execution.scope.kind !== "system") {
      throw new Error("Static marketplace publication requires System context.");
    }
    const runtime = getRuntime(context);
    if (runtime.kind !== "system") {
      throw new Error("System marketplace publication runtime is not available.");
    }
    return await runtime.pushStaticMarketplaceEntries(input);
  },
  adapters: {
    bash: {
      command: "internal.marketplace.push",
      help: {
        summary:
          "internal.marketplace.push publishes the bundled static marketplace entries from System context.",
        options: [
          {
            name: "force",
            description: "Publish with fresh workflow IDs and overwrite existing artifact files.",
          },
        ],
        examples: ["internal.marketplace.push --format json", "internal.marketplace.push --force"],
      },
      parse: defineCliArgsParser<{ force?: boolean }>("internal.marketplace.push", {
        force: { kind: "boolean" },
      }),
      outputOptions: (_args, parsed) => readOutputOptions(parsed),
      format: formatMarketplacePushOutput,
    },
  },
});

export const internalWorkspaceToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "internal",
  permissions: {
    manage: "Run internal runtime maintenance tasks.",
  },
  tools: [filesSeedExecuteTool],
  hidden: true,
  isAvailable: (context: InternalToolContext) =>
    (context.execution.scope.kind === "org" || context.execution.scope.kind === "project") &&
    context.runtimes.internal?.kind === "org",
});

export const internalMarketplaceToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "internal",
  permissions: {
    manage: "Run internal runtime maintenance tasks.",
  },
  tools: [marketplacePushTool],
  hidden: true,
  isAvailable: (context: InternalToolContext) =>
    context.execution.scope.kind === "system" && context.runtimes.internal?.kind === "system",
});
