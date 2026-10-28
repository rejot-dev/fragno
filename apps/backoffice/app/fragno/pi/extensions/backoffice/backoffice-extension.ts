import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import {
  defineExtension,
  section,
  type ConversationId,
  type Extension,
  type PromptInput,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import {
  requirePiStateBackend,
  type BackofficeAgentContext,
} from "@/fragno/pi/agent/backoffice-agent-context";

import { createCodemodeTool } from "./codemode-tool";
import { isUploadNotConfiguredError } from "./skills";
import { buildBackofficePiSystemPrompt } from "./system-prompt";

const WORKSPACE_INSTRUCTIONS_PATH = "/workspace/AGENTS.md";

/** What one request preparation's sections render from; each part fails only its own section. */
type PromptParts = {
  systemMd: Promise<string>;
  agentsMd: Promise<string | undefined>;
  agentDefinition: Promise<string>;
};

/**
 * Backoffice guidance, the agent's own instructions, and the tools every agent runs with, among
 * them `awaitSubagentsTool`, which subagents run without.
 */
export function createBackofficeExtension(
  agent: BackofficeAgentContext,
  awaitSubagentsTool: ToolRegistration,
): Extension {
  // Pi renders sections one after another but hands each the same `input` per request
  // preparation, so the sections share one turn read, one authorization, and concurrent reads.
  const preparations = new WeakMap<PromptInput, PromptParts>();
  function partsFor(input: PromptInput): PromptParts {
    let parts = preparations.get(input);
    if (!parts) {
      parts = preparePromptParts(agent, input.conversationId);
      preparations.set(input, parts);
    }
    return parts;
  }

  return defineExtension({
    name: "backoffice",
    // Discovery runs inside codemode through `state`, so it shares a turn with other reads.
    tools: [createCodemodeTool(agent), awaitSubagentsTool],
    sections: [
      section("system-md", (input) => partsFor(input).systemMd, { tag: false }),
      section("agents-md", (input) => partsFor(input).agentsMd, { tag: false }),
      // Without its name an agent cannot find its own definition among the pi.agent.* tools.
      section(
        "agent-identity",
        () =>
          `You are the Backoffice agent \`${agent.agentName}\`: that is your \`agentName\` in \`pi.agent.*\` tools, such as \`pi.getAgent({ agentName: "${agent.agentName}" })\` for your own definition.`,
        { tag: false },
      ),
      section(
        "agent-definition",
        async (input) => {
          const instructions = await partsFor(input).agentDefinition;
          return instructions.trim() === "" ? undefined : instructions;
        },
        { tag: false },
      ),
    ],
  });
}

function preparePromptParts(
  agent: BackofficeAgentContext,
  conversationId: ConversationId,
): PromptParts {
  const turn = agent.activeTurn(conversationId, BACKGROUND_CONTEXT).then(async (turn) => {
    await turn.authorize();
    return turn;
  });
  const runtimeToolContext = turn.then((turn) =>
    turn.toolContext(agent.agentName, null, BACKGROUND_CONTEXT),
  );
  const parts: PromptParts = {
    systemMd: runtimeToolContext.then((runtimeToolContext) =>
      buildBackofficePiSystemPrompt({ runtimeToolContext }),
    ),
    agentsMd: runtimeToolContext.then((context) =>
      readWorkspaceInstructions(requirePiStateBackend(context)),
    ),
    agentDefinition: turn.then((turn) => turn.instructions),
  };
  // A section that aborts the preparation leaves later parts unawaited; their sections report them.
  for (const part of Object.values(parts)) {
    part.catch(() => {});
  }
  return parts;
}

async function readWorkspaceInstructions(
  state: BackofficeStateBackend,
): Promise<string | undefined> {
  try {
    const instructions = await state.readFile(WORKSPACE_INSTRUCTIONS_PATH);
    return instructions.trim() === ""
      ? undefined
      : `Workspace instructions from \`${WORKSPACE_INSTRUCTIONS_PATH}\`:\n\n${instructions}`;
  } catch (error) {
    // Workspace guidance is optional, including in scopes without an Upload workspace.
    if (
      (error instanceof BackofficeOperationError && error.kind === "not_found") ||
      isUploadNotConfiguredError(error)
    ) {
      return undefined;
    }
    throw error;
  }
}
