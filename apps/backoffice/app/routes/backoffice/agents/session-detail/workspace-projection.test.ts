import { assert, describe, expect, test } from "vitest";

import { projectWorkflowGraph } from "./workflow-graph-projection";
import { generatedUiWorkspaceId, workflowGraphWorkspaceId } from "./workspace-model";
import { getSessionWorkflowRunIds, projectSessionWorkspaceItems } from "./workspace-projection";

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
        name: "execCodeMode",
        arguments: { code },
      },
    ],
    timestamp: 1,
  }) as never;

const toolResult = (id: string, result: unknown, details: Record<string, unknown> = {}) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "execCodeMode",
    content: [{ type: "text", text: "Completed" }],
    details: { result, logs: [], ...details },
    isError: false,
    timestamp: 2,
  }) as never;

describe("getSessionWorkflowRunIds", () => {
  test("returns only workflow runs referenced by the current session", () => {
    expect(
      getSessionWorkflowRunIds({
        draftAgentMessage: null,
        messages: [
          assistantToolCall("workflow-call", "defineWorkflow({ name: 'demo' }, async () => {});"),
          toolResult("workflow-call", null, { run: { instanceId: "session-run" } }),
          toolResult("ui-call", generatedUiResult),
        ],
      }),
    ).toEqual(["session-run"]);
  });
});

describe("projectSessionWorkspaceItems", () => {
  test("projects workflow construction and multiple generated interfaces in session order", () => {
    const items = projectSessionWorkspaceItems({
      draftAgentMessage: null,
      startedWorkflowRunIds: new Set(["workflow-instance"]),
      messages: [
        assistantToolCall(
          "workflow-call",
          `defineWorkflow({ name: "fulfil-orders" }, async (_event, step) => {
            await step.do("load orders", async () => []);
          });`,
        ),
        toolResult("workflow-call", generatedUiResult, {
          run: { instanceId: "workflow-instance" },
        }),
        assistantToolCall("ui-call", "async () => ({ total: 24 })"),
        toolResult("ui-call", generatedUiResult),
      ],
    });

    expect(items.map((item) => item.id)).toEqual([
      workflowGraphWorkspaceId("workflow-call"),
      generatedUiWorkspaceId("workflow-call"),
      generatedUiWorkspaceId("ui-call"),
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "fulfil-orders",
      "Interface 1",
      "Interface 2",
    ]);
    assert(items[0]?.view.type === "workflow-graph");
    expect(items[0].view.run).toEqual({
      workflowName: "codemode-script",
      instanceId: "workflow-instance",
    });
    expect(items[0].view.projection.visualization.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workflow", name: "fulfil-orders" }),
        expect.objectContaining({ kind: "step", label: "load orders" }),
      ]),
    );
  });

  test("deduplicates persisted and draft versions of the same tool call", () => {
    const items = projectSessionWorkspaceItems({
      startedWorkflowRunIds: new Set(["draft-run"]),
      messages: [
        assistantToolCall("shared-call", `defineWorkflow({ name: "old-name" }, async () => {});`),
        toolResult("shared-call", generatedUiResult),
      ],
      draftAgentMessage: {
        activity: "running_tools",
        startedAt: 1,
        updatedAt: 2,
        assistant: undefined,
        tools: {
          "shared-call": {
            id: "shared-call",
            name: "execCodeMode",
            args: { code: `defineWorkflow({ name: "new-name" }, async () => {});` },
            status: "done",
            resultMessage: toolResult("shared-call", generatedUiResult, {
              run: { instanceId: "draft-run" },
            }),
          },
        },
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      workflowGraphWorkspaceId("shared-call"),
      generatedUiWorkspaceId("shared-call"),
    ]);
    assert(items[0]?.view.type === "workflow-graph");
    assert(items[0].view.projection.title === "new-name");
    expect(items[0].view.run).toEqual({
      workflowName: "codemode-script",
      instanceId: "draft-run",
    });
  });

  test("keeps malformed generated UI in the tool card instead of creating a workspace item", () => {
    const items = projectSessionWorkspaceItems({
      draftAgentMessage: null,
      startedWorkflowRunIds: new Set(),
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

  test("does not project an inline workflow before its first step starts", () => {
    const items = projectSessionWorkspaceItems({
      messages: [],
      startedWorkflowRunIds: new Set(),
      draftAgentMessage: {
        activity: "tool_calling",
        startedAt: 1,
        updatedAt: 2,
        assistant: undefined,
        tools: {
          draft: {
            id: "draft",
            name: "execCodeMode",
            args: {},
            argsText:
              '{"code":"defineWorkflow({ name: \\"streaming-workflow\\" }, async (_event, step) => {\\n  await step.do(\\"still writing',
            status: "starting",
          },
        },
      },
    });

    expect(items).toEqual([]);
  });

  test("projects an inline workflow after its first step starts", () => {
    const items = projectSessionWorkspaceItems({
      draftAgentMessage: null,
      startedWorkflowRunIds: new Set(["started-run"]),
      messages: [
        assistantToolCall(
          "started-workflow",
          `defineWorkflow({ name: "started-workflow" }, async (_event, step) => {
            await step.do("first step", async () => true);
          });`,
        ),
        toolResult("started-workflow", null, { run: { instanceId: "started-run" } }),
      ],
    });

    expect(items.map((item) => item.id)).toEqual([workflowGraphWorkspaceId("started-workflow")]);
  });
});

describe("projectWorkflowGraph", () => {
  test("ignores comments, strings, and similarly named identifiers", () => {
    expect(
      projectWorkflowGraph({
        complete: false,
        toolCallId: "not-a-workflow",
        source: `
          // defineWorkflow({ name: "comment" }, async () => {});
          const example = "defineWorkflow({ name: 'string' })";
          defineWorkflowFactory();
        `,
      }),
    ).toBeNull();
  });

  test("requires a direct workflow call rather than a method declaration", () => {
    expect(
      projectWorkflowGraph({
        complete: true,
        toolCallId: "class-method",
        source: `class WorkflowFactory {
          defineWorkflow(config) {
            return config;
          }
        }`,
      }),
    ).toBeNull();

    expect(
      projectWorkflowGraph({
        complete: true,
        toolCallId: "object-method",
        source: `const workflowFactory = {
          defineWorkflow(config) {
            return config;
          },
        };`,
      }),
    ).toBeNull();
  });

  test("accepts a direct generic workflow call", () => {
    assert(
      projectWorkflowGraph({
        complete: true,
        toolCallId: "generic-workflow",
        source: `defineWorkflow<"generic-workflow", undefined, { ok: true }>(
          { name: "generic-workflow" },
          async () => ({ ok: true }),
        );`,
      })?.title === "generic-workflow",
    );
  });

  test("retains a useful partial graph while nested source is incomplete", () => {
    const projection = projectWorkflowGraph({
      complete: false,
      toolCallId: "partial-workflow",
      source: `defineWorkflow({ name: "partial" }, async (_event, step) => {
        await step.do("load", async () => {
          return await orders.list(`,
    });

    assert(projection?.status === "constructing");
    expect(projection?.visualization.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workflow", name: "partial" }),
        expect.objectContaining({ kind: "step", label: "load" }),
      ]),
    );
  });
});
