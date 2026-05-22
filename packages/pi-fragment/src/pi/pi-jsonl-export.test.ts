import { describe, expect, it } from "vitest";

import { drainDurableHooks } from "@fragno-dev/test";

import { PI_JSONL_EXPORT_CWD } from "./pi-jsonl-export";
import { buildHarness, createStreamFn, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { interactiveChatWorkflow } from "./workflows/interactive-chat-workflow";

const parseJsonl = (body: string) =>
  body
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("pi JSONL export route", () => {
  const startHarness = () => {
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          thinkingLevel: "medium",
          streamFn: createStreamFn("assistant:init"),
        },
      },
      tools: {},
      workflows: [interactiveChatWorkflow],
    };

    return buildHarness(config, { autoTickHooks: true });
  };

  it("exports a deterministic Pi v3 NDJSON attachment", async () => {
    const harness = await startHarness();
    try {
      const create = await harness.fragments.pi.callRoute("POST", "/sessions", {
        body: {
          workflow: interactiveChatWorkflow.name,
          name: "Command Session",
          input: { agentName: "default" },
        },
      });
      expect(create.type).toBe("json");
      if (create.type !== "json") {
        throw new Error(`Expected json response, got ${create.type}`);
      }
      const sessionId = create.data.id;

      await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
      await harness.workflows.runUntilIdle({
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        instanceRef: sessionId,
        reason: "create",
      });

      await harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
        pathParams: { sessionId },
        body: { kind: "prompt", input: { text: "hello export" } },
      });
      await drainDurableHooks(harness.workflows.fragment, { mode: "singlePass" });
      await harness.workflows.runUntilIdle({
        workflowName: interactiveChatWorkflow.name,
        instanceId: sessionId,
        instanceRef: sessionId,
        reason: "event",
      });

      const response = await harness.fragments.pi.callRouteRaw(
        "GET",
        "/sessions/:sessionId/export/pi-jsonl",
        { pathParams: { sessionId }, query: { cwd: "/tmp/evil" } },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
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
      expect(lines[1]).toMatchObject({ type: "session_info", id: "00000001", parentId: null });
      expect(lines[2]).toMatchObject({
        type: "model_change",
        id: "00000002",
        parentId: "00000001",
        provider: mockModel.provider,
        modelId: mockModel.id,
      });
      expect(lines[3]).toMatchObject({
        type: "thinking_level_change",
        id: "00000003",
        parentId: "00000002",
        thinkingLevel: "medium",
      });

      const entries = lines.slice(1);
      entries.forEach((entry, index) => {
        expect(entry["id"]).toBe((index + 1).toString(16).padStart(8, "0"));
        expect(entry["parentId"]).toBe(index === 0 ? null : entries[index - 1]?.["id"]);
      });

      const messages = lines.filter((line) => line["type"] === "message");
      expect(messages).toEqual([]);
    } finally {
      await harness.test.cleanup();
    }
  });

  it("returns SESSION_NOT_FOUND for missing sessions", async () => {
    const harness = await startHarness();
    try {
      const response = await harness.fragments.pi.callRoute(
        "GET",
        "/sessions/:sessionId/export/pi-jsonl",
        {
          pathParams: { sessionId: "missing" },
        },
      );
      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }
      expect(response.status).toBe(404);
      expect(response.error.code).toBe("SESSION_NOT_FOUND");
    } finally {
      await harness.test.cleanup();
    }
  });
});
