import { z } from "zod";

import {
  seedWorkspaceStarterFiles,
  type WorkspaceStarterFilesSeedOutput,
} from "@/files/seed-workspace-starter-files";
import { defineCliArgsParser, readOutputOptions } from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type InternalRuntime = {
  seedWorkspaceStarterFiles(input?: { force?: boolean }): Promise<WorkspaceStarterFilesSeedOutput>;
};

type InternalToolContext = BackofficeToolContext<{ internal?: InternalRuntime }>;

const workspaceStarterFilesSeedOutputSchema = z.object({
  provider: z.string(),
  force: z.boolean(),
  created: z.array(z.string()),
  overwritten: z.array(z.string()),
  skipped: z.array(z.string()),
});

const getRuntime = (context: InternalToolContext) => {
  if (!context.runtimes.internal) {
    throw new Error("Internal runtime is not available in this execution context");
  }
  return context.runtimes.internal;
};

export const createInternalRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): InternalRuntime => ({
  seedWorkspaceStarterFiles: async (input) =>
    await seedWorkspaceStarterFiles({ env, orgId, force: input?.force }),
});

const filesSeedExecuteTool = defineBackofficeRuntimeTool({
  id: "internal.files.seed.execute",
  namespace: "internal",
  name: "filesSeedExecute",
  description: "Seed the org workspace with starter files if they do not already exist.",
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
            description: "Overwrite starter files that already exist.",
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

export const internalRuntimeTools = [filesSeedExecuteTool] as const;

export const internalToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "internal",
  tools: internalRuntimeTools,
  hidden: true,
  isAvailable: (context: InternalToolContext) => !!context.runtimes.internal,
});
