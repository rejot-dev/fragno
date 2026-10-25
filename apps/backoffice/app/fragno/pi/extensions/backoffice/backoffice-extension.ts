import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";

import type { BackofficeAgentContext } from "@/fragno/pi/agent/backoffice-agent-context";

import { createCodemodeTool } from "./codemode-tool";
import { buildBackofficePiSystemPrompt } from "./system-prompt";

/** Backoffice guidance, the agent's own instructions, and the tools every agent runs with. */
export function createBackofficeExtension(agent: BackofficeAgentContext): Extension {
  return defineExtension({
    name: "backoffice",
    // Discovery runs inside codemode through `state`, so it shares a turn with other reads.
    tools: [createCodemodeTool(agent)],
    sections: [
      section(
        "backoffice",
        async () => {
          const turn = await agent.activeTurn(BACKGROUND_CONTEXT);
          await turn.authorize();
          return await buildBackofficePiSystemPrompt({
            runtimeToolContext: turn.toolContext(agent.agentName, BACKGROUND_CONTEXT),
          });
        },
        { tag: false },
      ),
      // Without its name an agent cannot find its own definition among the pi.agent.* tools.
      section(
        "identity",
        async () =>
          `You are the Backoffice agent \`${agent.agentName}\`: that is your \`agentName\` in \`pi.agent.*\` tools, such as \`pi.getAgent({ agentName: "${agent.agentName}" })\` for your own definition.`,
        { tag: false },
      ),
      section(
        "agent",
        async () => {
          const { instructions } = await agent.activeTurn(BACKGROUND_CONTEXT);
          return instructions.trim() === "" ? undefined : instructions;
        },
        { tag: false },
      ),
    ],
  });
}
