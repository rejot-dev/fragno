import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";

import type { BackofficeAgentContext } from "@/fragno/pi/agent/backoffice-agent-context";

import { createExecCodeModeTool } from "./exec-code-mode-tool";
import { createReadTool } from "./read-tool";
import { createSearchTool } from "./search-tool";
import { buildBackofficePiSystemPrompt } from "./system-prompt";

/** Backoffice guidance, the agent's own instructions, and the tools every agent runs with. */
export function createBackofficeExtension(agent: BackofficeAgentContext): Extension {
  return defineExtension({
    name: "backoffice",
    tools: [createExecCodeModeTool(agent), createReadTool(agent), createSearchTool(agent)],
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
