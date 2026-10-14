import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";

import type { BackofficeAgentContext } from "@/fragno/pi/agent/backoffice-agent-context";

import { createExecCodeModeTool } from "./exec-code-mode-tool";
import { createReadTool } from "./read-tool";
import { createSearchTool } from "./search-tool";
import { buildBackofficePiSystemPrompt } from "./system-prompt";

/** Backoffice guidance and the scoped read, search, and codemode tools every agent runs with. */
export function createBackofficeExtension(agent: BackofficeAgentContext): Extension {
  const promptContext = agent.toolContext(agent.sessionId, BACKGROUND_CONTEXT);
  return defineExtension({
    name: "backoffice",
    tools: [createExecCodeModeTool(agent), createReadTool(agent), createSearchTool(agent)],
    sections: [
      section(
        "backoffice",
        async () => {
          await agent.authorize();
          return await buildBackofficePiSystemPrompt({ runtimeToolContext: promptContext });
        },
        { tag: false },
      ),
    ],
  });
}
