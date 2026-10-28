import { Type } from "typebox";

import type { Context } from "@earendil-works/chord";
import {
  defineTool,
  type ConversationId,
  type SettledSubmissionRecord,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

import { watchPiSubagent, type PiSubagentState } from "@/fragno/pi/agent/pi-agent-subagents";

const awaitSubagentsParametersSchema = Type.Object({
  requestIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 50,
    description:
      "Request IDs of subagents of yourself, as `pi.submitPrompt({ ..., subagent: true })` returned them.",
  }),
});

/** Waits for the submission a request made in one of the agent's conversations. */
export type WaitForPiSubmission = (
  conversationId: ConversationId,
  requestId: string,
  context: Context,
) => Promise<SettledSubmissionRecord>;

type SubagentResult =
  | { requestId: string; status: "answered"; answer: string }
  | { requestId: string; status: "failed" | "dropped"; reason: string }
  | { requestId: string; status: "notFound" };

/**
 * Waits in the calling turn for subagents of this agent, wherever they stand: waiting for a slot,
 * running, or done. The agent object records every subagent from when the queue takes it, so a
 * request ID it has no record of was never one of its subagents. Subagents run without this tool:
 * four of them waiting on subagents they started would hold every slot those need.
 */
export function createAwaitSubagentsTool(waitForSubmission: WaitForPiSubmission): ToolRegistration {
  return defineTool({
    name: "awaitSubagents",
    description:
      "Wait for subagents you started with `pi.submitPrompt({ ..., subagent: true })` and get each one's final answer in this turn, in the order given. Subagents still waiting for a slot are waited for too. Don't also ask to be notified of subagents you wait for here.",
    parameters: awaitSubagentsParametersSchema,
    callers: ["model"],
    // A rerun after a restart reads the same records and submissions and waits again.
    replay: "safe",
    async execute({ requestIds }, api, context) {
      const results = await Promise.all(
        requestIds.map((requestId) => settle(api, waitForSubmission, requestId, context)),
      );
      return { output: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  });
}

async function settle(
  api: ToolExecutionApi,
  waitForSubmission: WaitForPiSubmission,
  requestId: string,
  context: Context,
): Promise<SubagentResult> {
  const state = await settledState(api, requestId, context);
  if (state === null) {
    return { requestId, status: "notFound" };
  }
  if (state.status === "dropped") {
    return { requestId, status: "dropped", reason: state.reason };
  }
  const settled = await waitForSubmission(
    state.conversationId as ConversationId,
    requestId,
    context,
  );
  if (settled.status === "unanswered") {
    return { requestId, status: "failed", reason: settled.reason };
  }
  if (settled.type !== "input") {
    throw new Error("A subagent's prompt is submitted as input.");
  }
  const answerId = settled.answer;
  const answer = await api.commit(async (tx) => await tx.entry(answerId), context);
  const messages = (answer?.model ?? []).filter((message) => message.role === "assistant");
  // A done submission names the assistant entry that answered it.
  if (messages.length === 0) {
    throw new Error(`Subagent ${requestId}'s answer entry ${answerId} holds no answer.`);
  }
  const text = messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return { requestId, status: "answered", answer: text };
}

/** The subagent's record once its prompt is submitted or it was dropped; null when it has none. */
async function settledState(
  api: ToolExecutionApi,
  requestId: string,
  context: Context,
): Promise<Extract<PiSubagentState, { status: "started" | "dropped" }> | null> {
  const watch = await watchPiSubagent(api, requestId, context);
  if (watch === undefined) {
    return null;
  }
  try {
    return await new Promise((resolve, reject) => {
      function check(state: PiSubagentState | null) {
        if (state === null) {
          resolve(null);
          return true;
        }
        if (state.status === "started" || state.status === "dropped") {
          resolve(state);
          return true;
        }
        return false;
      }
      if (check(watch.value)) {
        return;
      }
      watch.start(async (state) => void check(state));
      // A stop aborts the call, which cancels the watch.
      void watch.closed.then((end) => {
        reject(new Error(`Waiting for subagent ${requestId} ended: ${end.reason}.`));
      });
    });
  } finally {
    await watch.stop();
  }
}
