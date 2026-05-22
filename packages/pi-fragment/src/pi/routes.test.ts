import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createId } from "@fragno-dev/db/id";
import { z } from "zod";

import { drainDurableHooks } from "@fragno-dev/test";

import { definePiWorkflow } from "./dsl";
import { buildHarness, createStreamFn, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { interactiveChatWorkflow } from "./workflows/interactive-chat-workflow";

const textMessages = (messages: Array<{ role?: string; content?: unknown }>, role: string) =>
  messages.flatMap((message) => {
    if (message.role !== role || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((block) =>
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block
        ? [String(block.text)]
        : [],
    );
  });

const createConfig = (
  overrides: Partial<PiFragmentConfig["agents"][string]> = {},
): PiFragmentConfig => ({
  agents: {
    default: {
      name: "default",
      systemPrompt: "You are helpful.",
      model: mockModel,
      streamFn: createStreamFn("assistant:init"),
      ...overrides,
    },
  },
  tools: {},
  workflows: [interactiveChatWorkflow],
});

describe("pi-fragment Pi-shaped routes", () => {
  type TestHarness = Awaited<ReturnType<typeof buildHarness>>;
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await buildHarness(createConfig(), { autoTickHooks: true });
  });

  afterEach(async () => {
    await harness.test.cleanup();
  });

  const createSession = async () => {
    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: {
        workflow: interactiveChatWorkflow.name,
        name: "Pi Session",
        input: { agentName: "default" },
      },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("expected json response");
    }
    return response.data.id;
  };

  const runSessionUntilIdle = async (sessionId: string) => {
    await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
    await harness.workflows.runUntilIdle({
      workflowName: interactiveChatWorkflow.name,
      instanceId: sessionId,
      instanceRef: sessionId,
      reason: "event",
    });
  };

  it("creates an interactive chat workflow session", async () => {
    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: {
        workflow: interactiveChatWorkflow.name,
        name: "Pi Session",
        input: { agentName: "default" },
      },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("expected json response");
    }

    expect(response.data).toMatchObject({
      name: "Pi Session",
      agent: "default",
      workflowName: interactiveChatWorkflow.name,
    });
    await expect(
      harness.workflows.getStatus(interactiveChatWorkflow.name, response.data.id),
    ).resolves.toEqual(expect.objectContaining({ status: "active" }));
  });

  it("rejects unknown custom workflow session creation", async () => {
    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: { workflow: "missing", input: {} },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error("expected error response");
    }
    expect(response.status).toBe(404);
    expect(response.error.code).toBe("WORKFLOW_NOT_FOUND");
  });

  it("lets one workflow session start another through the Pi service", async () => {
    await harness.test.cleanup();
    let piServices: TestHarness["fragments"]["pi"]["services"];
    const child = definePiWorkflow({ name: "child" }, () => ({ ok: true }));
    const parent = definePiWorkflow({ name: "parent" }, async (ctx) => {
      await ctx.step.do("start-child", (tx) => {
        const childSessionId = createId();
        const createdAt = new Date();
        tx.serviceCalls(() => [
          piServices.createWorkflowSession({
            id: childSessionId,
            workflowName: "child",
            agent: "child",
            name: "Child",
            createdAt,
            params: {},
          }),
        ]);
      });
      return { ok: true };
    });
    harness = await buildHarness(createConfig(), {
      workflows: [parent, child],
    });
    piServices = harness.fragments.pi.services;

    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: { workflow: "parent", input: {}, name: "Parent" },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("expected json response");
    }

    await harness.workflows.runUntilIdle({
      workflowName: "parent",
      instanceId: response.data.id,
      instanceRef: response.data.id,
      reason: "create",
    });
    await drainDurableHooks(harness.workflows.fragment);

    await expect(harness.workflows.getStatus("parent", response.data.id)).resolves.toEqual(
      expect.objectContaining({ status: "complete" }),
    );

    const sessions = await harness.fragments.pi.callRoute("GET", "/sessions", {});
    expect(sessions.type).toBe("json");
    if (sessions.type !== "json") {
      throw new Error("expected json response");
    }
    expect(sessions.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Parent", workflowName: "parent" }),
        expect.objectContaining({ name: "Child", workflowName: "child" }),
      ]),
    );
  });

  it("creates a valid custom workflow session", async () => {
    await harness.test.cleanup();
    const workflow = definePiWorkflow(
      { name: "custom", schema: z.object({ topic: z.string() }) },
      (ctx) => ({ topic: ctx.params.topic }),
    );
    harness = await buildHarness(createConfig(), { autoTickHooks: true, workflows: [workflow] });

    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: { workflow: "custom", input: { topic: "durability" }, name: "Custom" },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("expected json response");
    }

    expect(response.data).toMatchObject({
      name: "Custom",
      agent: "custom",
      workflowName: "custom",
    });
    await expect(harness.workflows.getStatus("custom", response.data.id)).resolves.toEqual(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("loads custom workflow status, events, and commands through the session workflow name", async () => {
    await harness.test.cleanup();
    const workflow = definePiWorkflow({ name: "approval" }, async (ctx) => {
      const command = await ctx.waitForEvent("approval", {
        allowed: ["complete"],
      });
      return { command: command.kind };
    });
    harness = await buildHarness(createConfig(), { workflows: [workflow] });

    const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
      body: { workflow: "approval", input: {}, name: "Approval" },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("expected json response");
    }

    await harness.workflows.runUntilIdle({
      workflowName: "approval",
      instanceId: response.data.id,
      instanceRef: response.data.id,
      reason: "create",
    });

    const events = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId/events", {
      pathParams: { sessionId: response.data.id },
      query: { once: "true" },
    });
    expect(events.type).toBe("jsonStream");
    if (events.type !== "jsonStream") {
      throw new Error("expected json stream response");
    }
    const frames: unknown[] = [];
    for await (const frame of events.stream) {
      frames.push(frame);
    }
    expect(frames).toEqual([expect.objectContaining({ type: "snapshot" })]);

    const command = await harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId: response.data.id },
      body: { kind: "complete" },
    });
    expect(command.type).toBe("json");
    if (command.type !== "json") {
      throw new Error("expected json response");
    }
    expect(command.data.accepted).toBe(true);

    await harness.workflows.runUntilIdle({
      workflowName: "approval",
      instanceId: response.data.id,
      instanceRef: response.data.id,
      reason: "event",
    });

    const detail = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId: response.data.id },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error("expected json response");
    }
    expect(detail.data.workflow).toMatchObject({
      status: "complete",
      output: { command: "complete" },
    });
  });

  it("creates a session with empty Pi state and no old public detail fields", async () => {
    const sessionId = await createSession();

    const detail = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error("expected json response");
    }

    expect(detail.data.agent.state.messages).toEqual([]);
    expect(detail.data.agent.events).toEqual([]);
    expect(detail.data).not.toHaveProperty("trace");
    expect(detail.data).not.toHaveProperty("turns");
    expect(detail.data).not.toHaveProperty("commandHistory");
    expect(detail.data).not.toHaveProperty("phase");
    expect(detail.data).not.toHaveProperty("turn");
    expect(detail.data).not.toHaveProperty("waitingFor");
  });

  it("accepts prompt commands without projecting in-flight events into session detail", async () => {
    const sessionId = await createSession();
    await runSessionUntilIdle(sessionId);

    const command = await harness.fragments.pi.callRoute("POST", "/sessions/:sessionId/command", {
      pathParams: { sessionId },
      body: { kind: "prompt", input: { text: "hello" } },
    });
    expect(command.type).toBe("json");
    if (command.type !== "json") {
      throw new Error("expected json response");
    }
    expect(command.data.accepted).toBe(true);

    await drainDurableHooks(harness.workflows.fragment);
    await runSessionUntilIdle(sessionId);

    let detail = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });
    for (
      let attempt = 0;
      attempt < 20 && detail.type === "json" && detail.data.agent.state.messages.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      detail = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });
    }
    expect(detail.type).toBe("json");
    if (detail.type !== "json") {
      throw new Error("expected json response");
    }

    expect(textMessages(detail.data.agent.state.messages, "user")).toEqual([]);
    expect(textMessages(detail.data.agent.state.messages, "assistant")).toEqual([]);
    expect(detail.data.agent.events).toEqual([]);
  });

  it("streams an initial snapshot from /events", async () => {
    const sessionId = await createSession();

    const stream = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId/events", {
      pathParams: { sessionId },
    });
    expect(stream.type).toBe("jsonStream");
    if (stream.type !== "jsonStream") {
      throw new Error("expected json stream response");
    }

    const frames: unknown[] = [];
    for await (const frame of stream.stream) {
      frames.push(frame);
      break;
    }

    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "snapshot",
        state: expect.objectContaining({ messages: [] }),
      }),
    );
  });
});
