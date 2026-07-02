import { describe, expect, it, assert } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import { exportSessionStorageToJsonl, PI_JSONL_EXPORT_CWD } from "./pi-jsonl-export";
import { buildHarness, createHarnessOptions, createTextStreamFn } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { createInteractiveChatWorkflow } from "./workflows/interactive-chat-workflow";

const parseJsonl = (body: string) =>
  body
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const textContent = (message: unknown): string[] => {
  if (typeof message !== "object" || message === null || !("content" in message)) {
    return [];
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block
      ? [String(block.text)]
      : [],
  );
};

describe("pi JSONL export", () => {
  it("exports a Pi v3 NDJSON attachment from workflow-backed session storage", async () => {
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: {
        default: createHarnessOptions({
          thinkingLevel: "medium",
          streamFn: createTextStreamFn("assistant:export"),
        }),
      },
    });
    const config: PiFragmentConfig = { workflows: [interactiveChatWorkflow] };
    const harness = await buildHarness(config, { autoTickHooks: true });

    try {
      const create = await harness.fragments.pi.callRoute(
        "POST",
        "/workflows/:workflowName/sessions",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name },
          body: {
            name: "Command Session",
            input: { harnessName: "default" },
          },
        },
      );
      assert(create.type === "json");
      const sessionId = create.data.id;

      await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
      await harness.workflows.runUntilIdle({
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        reason: "create",
      });

      await harness.fragments.pi.callRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
          body: { kind: "prompt", input: { text: "hello export" } },
        },
      );
      await drainDurableHooks(harness.workflows.fragment, { mode: "singlePass" });
      await harness.workflows.runUntilIdle({
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        reason: "event",
      });

      const response = await harness.fragments.pi.callRouteRaw(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/export/pi-jsonl",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
          query: { cwd: "/tmp/ignored" },
        },
      );

      assert(response.status === 200);
      assert(response.headers.get("content-type") === "application/x-ndjson; charset=utf-8");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="pi-session-${sessionId}.jsonl"`,
      );

      const lines = parseJsonl(await response.text());
      expect(lines[0]).toMatchObject({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: PI_JSONL_EXPORT_CWD,
      });
      expect(lines[0]?.["parentSession"]).toBeUndefined();

      const entries = lines.slice(1);
      expect(entries.map((entry) => entry["type"])).toEqual(["message", "message"]);
      expect(entries[0]?.["parentId"]).toBeNull();
      expect(entries[1]?.["parentId"]).toBe(entries[0]?.["id"]);

      const messages = entries.map((entry) => entry["message"]);
      expect(messages).toMatchObject([{ role: "user" }, { role: "assistant" }]);
      expect(textContent(messages[0])).toEqual(["hello export"]);
      expect(textContent(messages[1])).toEqual(["assistant:export"]);
    } finally {
      await harness.test.cleanup();
    }
  });

  it("returns SESSION_NOT_FOUND for missing sessions", async () => {
    const interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: { default: createHarnessOptions() },
    });
    const harness = await buildHarness({ workflows: [interactiveChatWorkflow] });

    try {
      const response = await harness.fragments.pi.callRoute(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/export/pi-jsonl",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId: "missing" },
        },
      );
      assert(response.type === "error");
      assert(response.status === 404);
      assert(response.error.code === "SESSION_NOT_FOUND");
    } finally {
      await harness.test.cleanup();
    }
  });

  it("preserves the current leaf when it differs from the final append-log entry", async () => {
    const entries = [
      {
        type: "message" as const,
        id: "root",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "user" as const,
          content: [{ type: "text" as const, text: "root" }],
          timestamp: 0,
        },
      },
      {
        type: "label" as const,
        id: "label-root",
        parentId: "root",
        timestamp: "2026-01-01T00:00:02.000Z",
        targetId: "root",
        label: "after leaf",
      },
    ];
    const storage = {
      async getMetadata() {
        return { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
      },
      async getEntries() {
        return entries;
      },
      async getLeafId() {
        return "root";
      },
    } as Parameters<typeof exportSessionStorageToJsonl>[0];

    const lines = parseJsonl(
      await exportSessionStorageToJsonl(storage, {
        cwd: PI_JSONL_EXPORT_CWD,
        parentSessionPath: "/tmp/parent.jsonl",
      }),
    );

    expect(lines[0]).toMatchObject({
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: PI_JSONL_EXPORT_CWD,
      parentSession: "/tmp/parent.jsonl",
    });
    expect(lines.at(-1)).toMatchObject({
      type: "leaf",
      parentId: "label-root",
      targetId: "root",
    });
    assert(typeof lines.at(-1)?.["id"] === "string");
  });
});
