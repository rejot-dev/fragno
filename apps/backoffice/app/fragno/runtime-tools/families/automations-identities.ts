import type {
  ListExternalIdentitiesInput,
  ListExternalIdentitiesOutput,
} from "@fragno-dev/backoffice-api/v0/identity";

import type { ResolveExternalIdentityResult } from "@/fragno/automation/external-identities";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";

export type ResolveExternalIdentityArgs = {
  source: string;
  type: string;
  id: string;
};

export type AutomationIdentityRuntime = {
  resolveExternal: (input: ResolveExternalIdentityArgs) => Promise<ResolveExternalIdentityResult>;
  listExternal: (input: ListExternalIdentitiesInput) => Promise<ListExternalIdentitiesOutput>;
};

type AutomationIdentityToolContext = BackofficeToolContext<{
  identity?: AutomationIdentityRuntime;
}>;

const getAutomationIdentityRuntime = (
  runtime: AutomationIdentityToolContext["runtimes"]["identity"],
): AutomationIdentityRuntime => {
  if (!runtime) {
    throw new Error("External identity runtime is not available in this execution context");
  }
  return runtime;
};

const parseResolveExternalIdentity = defineCliArgsParser<ResolveExternalIdentityArgs>(
  "identity.external.resolve",
  {
    source: { required: true },
    type: { required: true },
    id: { required: true },
  },
);

const resolveExternalIdentityTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("identity.external.resolve"),
  namespace: "identity",
  name: "resolveExternal",
  execute: async (input, context: AutomationIdentityToolContext) =>
    await getAutomationIdentityRuntime(context.runtimes.identity).resolveExternal(input),
  adapters: {
    bash: {
      command: "identity.external.resolve",
      help: {
        summary: "Resolve an active external identity binding from workflow logic.",
        options: [
          {
            name: "source",
            required: true,
            valueRequired: true,
            valueName: "source",
            description: "External identity source, such as telegram",
          },
          {
            name: "type",
            required: true,
            valueRequired: true,
            valueName: "type",
            description: "External identity type, such as chat",
          },
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "External identity identifier",
          },
        ],
        examples: [
          "identity.external.resolve --source telegram --type chat --id 1001 --print userId",
        ],
      },
      parse: parseResolveExternalIdentity,
      format: (result) =>
        result
          ? { data: result }
          : { stderr: "External identity binding not found.\n", exitCode: 1 },
    },
  },
});

const listExternalIdentitiesTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("identity.external.list"),
  namespace: "identity",
  name: "listExternal",
  execute: async (input, context: AutomationIdentityToolContext) =>
    await getAutomationIdentityRuntime(context.runtimes.identity).listExternal(input),
  adapters: {
    bash: {
      command: "identity.external.list",
      help: {
        summary:
          "identity.external.list lists external identities bound to users in the current scope.",
        options: [
          {
            name: "limit",
            valueRequired: true,
            valueName: "number",
            description: "Page size (1–500; defaults to 100).",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor returned by the previous page.",
          },
        ],
        examples: [
          "identity.external.list",
          "identity.external.list --limit 25 --format json",
          "identity.external.list --cursor '<cursor>'",
        ],
      },
      parse: defineCliArgsParser<ListExternalIdentitiesInput>("identity.external.list", {
        limit: { kind: "positiveInteger" },
        cursor: {},
      }),
      format: (result, options) => {
        if (options.format === "json" || options.print) {
          return { data: result };
        }
        const lines = result.bindings.length
          ? [
              "source\ttype\texternal id\tuser\tstatus\tbound at",
              ...result.bindings.map(
                (binding) =>
                  `${binding.source}\t${binding.type}\t${binding.externalId}\t${binding.userId}\t${binding.status}\t${binding.boundAt}`,
              ),
            ]
          : ["No external identity bindings found."];
        if (result.nextCursor) {
          lines.push(`next cursor: ${result.nextCursor}`);
        }
        return { stdout: `${lines.join("\n")}\n` };
      },
    },
  },
});

export const automationIdentityRuntimeTools = [
  resolveExternalIdentityTool,
  listExternalIdentitiesTool,
] as const;

export const automationIdentityToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "identity",
  tools: automationIdentityRuntimeTools,
  isAvailable: (context: AutomationIdentityToolContext) => !!context.runtimes.identity,
});
