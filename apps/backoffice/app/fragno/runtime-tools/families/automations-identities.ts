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

export const automationIdentityRuntimeTools = [resolveExternalIdentityTool] as const;

export const automationIdentityToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "identity",
  tools: automationIdentityRuntimeTools,
  isAvailable: (context: AutomationIdentityToolContext) => !!context.runtimes.identity,
});
