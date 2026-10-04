import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type HarnessOptions,
} from "@earendil-works/pi-durable";

import { Pi } from "./pi.do";

/** Scripted provider and real tool tasks shared by local and Cloudflare durable Pi scenarios. */
export function createPiScenarioHarnessOptions(): HarnessOptions {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "durable tool result" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("durable answer")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "scenario",
      tools: [
        defineTool({
          name: "echo",
          description: "Echo the provided text.",
          parameters: Type.Object({ text: Type.String() }),
          replay: "safe",
          execute: async ({ text }) => ({ content: [{ type: "text", text }] }),
        }),
      ],
    }),
  );
  return { models, registry };
}

/** Runs the production Cloudflare agent with the shared scripted provider. */
export class PiScenarioAgent extends Pi {
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env, createPiScenarioHarnessOptions());
  }
}
