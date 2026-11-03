import { assert, expect, test } from "vitest";

import type { ConversationView } from "@earendil-works/pi-durable";

import { piConversationActivity } from "./conversation-activity";

/** A view of answers calling tools, the results that came back, and the current round's slots. */
function view(entries: readonly object[], tools?: readonly object[]) {
  return {
    conversation: { id: 1 },
    entries: entries.map((message, index) => ({
      id: index + 1,
      conversationId: 1,
      kind: "pi.message",
      model: [message],
    })),
    docs: tools === undefined ? {} : { "pi.live": { tools } },
  } as unknown as ConversationView;
}

/** An answer calling tools, which starts a round only when it stopped to use them. */
function answer(ids: string[], stopReason: "toolUse" | "error" | "aborted" = "toolUse") {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "toolCall", id, name: "codemode", arguments: {} })),
    stopReason,
  };
}

function result(id: string, isError = false) {
  return { role: "toolResult", toolCallId: id, toolName: "codemode", content: [], isError };
}

function slot(callId: string, status: "running" | "done") {
  return { callId, name: "codemode", status };
}

function tool(toolCallId: string, status: "running" | "succeeded" | "failed") {
  return { toolCallId, name: "codemode", status, calls: null };
}

test("tools keep the order their answer called them in, however they finish", () => {
  // B finished first; A still runs.
  expect(
    piConversationActivity(
      view([answer(["a", "b"]), result("b")], [slot("a", "running"), slot("b", "done")]),
    ),
  ).toEqual({ tools: [tool("a", "running"), tool("b", "succeeded")], omitted: 0 });
  expect(
    piConversationActivity(view([answer(["a", "b"]), result("b"), result("a", true)])),
  ).toEqual({
    tools: [tool("a", "failed"), tool("b", "succeeded")],
    omitted: 0,
  });
});

test("a tool that ended without a result stays failed once its round ends", () => {
  // A faulted: its slot is done, and no result came.
  expect(
    piConversationActivity(view([answer(["a"]), answer(["b"])], [slot("b", "running")])).tools,
  ).toEqual([tool("a", "failed"), tool("b", "running")]);
  expect(piConversationActivity(view([answer(["a"])], [slot("a", "done")])).tools).toEqual([
    tool("a", "failed"),
  ]);
  // The run ended and took the round's slots with it.
  expect(piConversationActivity(view([answer(["a"])])).tools).toEqual([tool("a", "failed")]);
});

test("a call's ID reused in a later round names that round's call", () => {
  expect(
    piConversationActivity(
      view([answer(["same"]), result("same", true), answer(["same"]), result("same")]),
    ).tools,
  ).toEqual([tool("same", "failed"), tool("same", "succeeded")]);
  // The earlier round's result is not the running call's, nor is the running call's slot the earlier one's.
  expect(
    piConversationActivity(
      view([answer(["same"]), result("same"), answer(["same"])], [slot("same", "running")]),
    ).tools,
  ).toEqual([tool("same", "succeeded"), tool("same", "running")]);
});

test("an answer that ended in an error or was cut short ran none of its calls", () => {
  expect(
    piConversationActivity(view([answer(["a"], "error"), answer(["b"], "aborted"), answer(["c"])]))
      .tools,
  ).toEqual([tool("c", "failed")]);
});

test("a long conversation keeps its newest 50 tools, with their calls", () => {
  const calls = { startedAt: 0, items: [], omitted: 0 };
  const ids = Array.from({ length: 52 }, (_, index) => `call-${index}`);
  const activity = piConversationActivity(
    view(ids.flatMap((id) => [answer([id]), { ...result(id), details: { calls } }])),
  );
  assert.equal(activity.omitted, 2);
  expect(activity.tools.map((each) => each.toolCallId)).toEqual(ids.slice(2));
  assert(activity.tools.every((each) => each.calls !== null));
});
