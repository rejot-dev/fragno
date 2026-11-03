import type { PiAgentActivity } from "@fragno-dev/backoffice-api/v0/pi";

import type { ConversationView, LiveState } from "@earendil-works/pi-durable";

import { getCodemodeCallsDetail } from "@/fragno/pi/extensions/backoffice/codemode-call-details";

// A subagent runs a handful of tools; the bound keeps a long conversation's answer small.
const MAX_TOOLS = 50;

type Message = NonNullable<ConversationView["entries"][number]["model"]>[number];
type ToolResult = Extract<Message, { role: "toolResult" }>;
type Tool = Omit<PiAgentActivity["tools"][number], "calls"> & { details: unknown };

/**
 * The tools a conversation's view shows it ran, in the order its answers called them. As Pi runs
 * them, only an answer that stopped to use tools starts a round, whose results come before the
 * next answer: a model may reuse a call's ID in another round, and an answer that ended in an error
 * or was cut short ran none of the calls it holds. A call shows by its result, else by its slot
 * while the newest round runs; one that ended without a result, because it faulted or was
 * orphaned, failed. Its newest tools are kept, and only their calls are read.
 */
export function piConversationActivity(view: ConversationView): PiAgentActivity {
  const messages = view.entries.flatMap((entry) => entry.model ?? []);
  const rounds: { calls: { id: string; name: string }[]; results: Map<string, ToolResult> }[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || message.stopReason !== "toolUse") {
      continue;
    }
    const calls = message.content.filter((part) => part.type === "toolCall");
    if (calls.length === 0) {
      continue;
    }
    const results = new Map<string, ToolResult>();
    for (let next = index + 1; next < messages.length; next++) {
      const candidate = messages[next];
      if (candidate.role === "assistant") {
        break;
      }
      if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) {
        results.set(candidate.toolCallId, candidate);
      }
    }
    rounds.push({ calls, results });
  }
  // Pi's own document, which the view carries by kind; its slots are the newest round's.
  const live = view.docs["pi.live"] as Readonly<LiveState> | undefined;
  const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));

  const tools: Tool[] = [];
  for (const [index, { calls, results }] of rounds.entries()) {
    const newest = index === rounds.length - 1;
    for (const call of calls) {
      const result = results.get(call.id);
      const slot = newest ? slots.get(call.id) : undefined;
      tools.push(
        result
          ? {
              toolCallId: call.id,
              name: call.name,
              status: result.isError ? "failed" : "succeeded",
              details: result.details,
            }
          : {
              toolCallId: call.id,
              name: call.name,
              status: slot && slot.status !== "done" ? "running" : "failed",
              details: slot?.details,
            },
      );
    }
  }
  return {
    tools: tools
      .slice(-MAX_TOOLS)
      .map(({ details, ...tool }) => ({ ...tool, calls: getCodemodeCallsDetail(details) })),
    omitted: Math.max(0, tools.length - MAX_TOOLS),
  };
}
