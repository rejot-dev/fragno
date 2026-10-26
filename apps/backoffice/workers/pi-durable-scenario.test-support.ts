import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

import type { PiAgentDependencies } from "@/fragno/pi/agent/pi-agent-harness";

import { Pi } from "./pi.do";

/** Scripted models with only Backoffice's own extensions installed. */
export function createScriptedPiAgentDependencies(models: Models): PiAgentDependencies {
  return {
    models,
    extensions: () => [],
    settings: {},
    report: (error) => {
      console.error(error);
    },
  };
}

/** Scripted provider and real tool tasks shared by local and Cloudflare durable Pi scenarios. */
export function createPiScenarioDependencies(): PiAgentDependencies {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "durable tool result" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("durable answer")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const scenario = defineExtension({
    name: "scenario",
    tools: [
      defineTool({
        name: "echo",
        description: "Echo the provided text.",
        parameters: Type.Object({ text: Type.String() }),
        replay: "safe",
        execute: async ({ text }) => ({ output: [{ type: "text", text }] }),
      }),
    ],
  });
  return { ...createScriptedPiAgentDependencies(models), extensions: () => [scenario] };
}

/** Runs the production Cloudflare agent with the shared scripted provider. */
export class PiScenarioAgent extends Pi {
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env, async () => createPiScenarioDependencies());
  }
}
