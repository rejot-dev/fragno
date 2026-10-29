import { describe, expect, test } from "vitest";

import { generatedUiWorkspaceId } from "./workspace-model";
import { projectSessionWorkspaceItems } from "./workspace-projection";

const generatedUiResult = {
  total: 24,
  $ui: {
    version: 1,
    state: { total: 24 },
    spec: {
      root: "metric",
      elements: {
        metric: {
          type: "Metric",
          props: { label: "Orders", value: "24" },
          children: [],
        },
      },
    },
  },
};

const assistantToolCall = (id: string, code: string) =>
  ({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "codemode",
        arguments: { code },
      },
    ],
    timestamp: 1,
  }) as never;

const toolResult = (id: string, result: unknown) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "codemode",
    content: [{ type: "text", text: "Completed" }],
    details: { result, logs: [] },
    isError: false,
    timestamp: 2,
  }) as never;

describe("projectSessionWorkspaceItems", () => {
  test("projects multiple generated interfaces in session order", () => {
    const items = projectSessionWorkspaceItems({
      draftAgentMessage: null,
      messages: [
        assistantToolCall("first-call", "async () => ({ total: 24 })"),
        toolResult("first-call", generatedUiResult),
        assistantToolCall("second-call", "async () => ({ total: 24 })"),
        toolResult("second-call", generatedUiResult),
      ],
    });

    expect(items.map((item) => item.id)).toEqual([
      generatedUiWorkspaceId("first-call"),
      generatedUiWorkspaceId("second-call"),
    ]);
    expect(items.map((item) => item.label)).toEqual(["Interface 1", "Interface 2"]);
  });

  test("deduplicates persisted and draft versions of the same tool call", () => {
    const items = projectSessionWorkspaceItems({
      messages: [
        assistantToolCall("shared-call", "async () => ({ total: 24 })"),
        toolResult("shared-call", generatedUiResult),
      ],
      draftAgentMessage: {
        activity: "running_tools",
        assistant: undefined,
        tools: {
          "shared-call": {
            id: "shared-call",
            name: "codemode",
            args: { code: "async () => ({ total: 24 })" },
            status: "done",
            resultMessage: toolResult("shared-call", generatedUiResult),
          },
        },
      },
    });

    expect(items.map((item) => item.id)).toEqual([generatedUiWorkspaceId("shared-call")]);
  });

  test("keeps malformed generated UI in the tool card instead of creating a workspace item", () => {
    const items = projectSessionWorkspaceItems({
      draftAgentMessage: null,
      messages: [
        assistantToolCall("invalid-ui", "async () => ({})"),
        toolResult("invalid-ui", {
          ...generatedUiResult,
          $ui: { ...generatedUiResult.$ui, version: 2 },
        }),
      ],
    });

    expect(items).toEqual([]);
  });
});
