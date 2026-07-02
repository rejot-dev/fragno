import { afterEach, beforeEach, describe, expect, it, assert } from "vitest";

import { createId } from "@fragno-dev/db/id";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { drainDurableHooks } from "@fragno-dev/test";

import { waitForPiCommand } from "./harness/commands";
import { buildHarness, createHarnessOptions } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { createInteractiveChatWorkflow } from "./workflows/interactive-chat-workflow";

type TestHarness = Awaited<ReturnType<typeof buildHarness>>;

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

const createConfig = () => {
  const interactiveChatWorkflow = createInteractiveChatWorkflow({
    harnesses: {
      default: createHarnessOptions(),
    },
  });

  return {
    interactiveChatWorkflow,
    config: {
      workflows: [interactiveChatWorkflow],
    } satisfies PiFragmentConfig,
  };
};

const assertJson = <T extends { type: string }>(response: T): Extract<T, { type: "json" }> => {
  assert(response.type === "json");
  return response as Extract<T, { type: "json" }>;
};

const assertError = <T extends { type: string }>(response: T): Extract<T, { type: "error" }> => {
  assert(response.type === "error");
  return response as Extract<T, { type: "error" }>;
};

const assertJsonStream = <T extends { type: string }>(
  response: T,
): Extract<T, { type: "jsonStream" }> => {
  assert(response.type === "jsonStream");
  return response as Extract<T, { type: "jsonStream" }>;
};

describe("pi-harness routes", () => {
  let harness: TestHarness;
  let interactiveChatWorkflow: ReturnType<typeof createInteractiveChatWorkflow>;

  beforeEach(async () => {
    const setup = createConfig();
    interactiveChatWorkflow = setup.interactiveChatWorkflow;
    harness = await buildHarness(setup.config, { autoTickHooks: true });
  });

  afterEach(async () => {
    await harness.test.cleanup();
  });

  const createSession = async () => {
    const response = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: interactiveChatWorkflow.name },
        body: {
          name: "Pi Session",
          input: { harnessName: "default" },
        },
      }),
    );
    return response.data.id as string;
  };

  const runSessionUntilIdle = async (sessionId: string, reason: "create" | "event" = "event") => {
    await harness.workflows.getStatus(interactiveChatWorkflow.name, sessionId);
    await harness.workflows.runUntilIdle({
      workflowName: interactiveChatWorkflow.name,
      instanceId: sessionId,
      reason,
    });
  };

  it("creates an interactive chat workflow session", async () => {
    const response = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: interactiveChatWorkflow.name },
        body: {
          name: "Pi Session",
          input: { harnessName: "default" },
        },
      }),
    );

    expect(response.data).toMatchObject({
      name: "Pi Session",
      agent: "default",
      workflowName: interactiveChatWorkflow.name,
    });
    await expect(
      harness.workflows.getStatus(interactiveChatWorkflow.name, response.data.id),
    ).resolves.toEqual(expect.objectContaining({ status: "active" }));
  });

  it("rejects unknown workflow session creation", async () => {
    const response = assertError(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "missing" },
        body: { input: {} },
      }),
    );

    assert(response.status === 404);
    assert(response.error.code === "WORKFLOW_NOT_FOUND");
  });

  it("allows different workflows to reuse the same public session id", async () => {
    await harness.test.cleanup();
    const first = defineWorkflow({ name: "first" }, () => ({ ok: true }));
    const second = defineWorkflow({ name: "second" }, () => ({ ok: true }));
    harness = await buildHarness({ workflows: [first, second] });

    await harness.fragments.pi.callServices(() => [
      harness.fragments.pi.services.createWorkflowSession({
        id: "shared-session",
        workflowName: "first",
        agent: "first",
        name: "First",
        createdAt: new Date(),
        params: {},
      }),
      harness.fragments.pi.services.createWorkflowSession({
        id: "shared-session",
        workflowName: "second",
        agent: "second",
        name: "Second",
        createdAt: new Date(),
        params: {},
      }),
    ]);

    const firstSessions = assertJson(
      await harness.fragments.pi.callRoute("GET", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "first" },
      }),
    );
    const secondSessions = assertJson(
      await harness.fragments.pi.callRoute("GET", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "second" },
      }),
    );

    expect(firstSessions.data).toEqual([
      expect.objectContaining({ id: "shared-session", workflowName: "first" }),
    ]);
    expect(secondSessions.data).toEqual([
      expect.objectContaining({ id: "shared-session", workflowName: "second" }),
    ]);
  });

  it("lets one workflow session start another through the Pi service", async () => {
    await harness.test.cleanup();
    let piServices: TestHarness["fragments"]["pi"]["services"];
    const child = defineWorkflow({ name: "child" }, () => ({ ok: true }));
    const parent = defineWorkflow({ name: "parent" }, async (_event, step) => {
      await step.do("start-child", (tx) => {
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
    harness = await buildHarness({ workflows: [parent, child] });
    piServices = harness.fragments.pi.services;

    const response = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "parent" },
        body: { input: {}, name: "Parent" },
      }),
    );

    await harness.workflows.runUntilIdle({
      workflowName: "parent",
      instanceId: response.data.id,
      reason: "create",
    });
    await drainDurableHooks(harness.workflows.fragment);

    await expect(harness.workflows.getStatus("parent", response.data.id)).resolves.toEqual(
      expect.objectContaining({ status: "complete" }),
    );

    const parentSessions = assertJson(
      await harness.fragments.pi.callRoute("GET", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "parent" },
      }),
    );
    const childSessions = assertJson(
      await harness.fragments.pi.callRoute("GET", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "child" },
      }),
    );

    expect(parentSessions.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Parent", workflowName: "parent" })]),
    );
    expect(childSessions.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Child", workflowName: "child" })]),
    );
  });

  it("creates a valid custom workflow session", async () => {
    await harness.test.cleanup();
    const workflow = defineWorkflow(
      { name: "custom", schema: z.object({ topic: z.string() }) },
      (event) => ({ topic: event.payload.topic }),
    );
    harness = await buildHarness({ workflows: [workflow] }, { autoTickHooks: true });

    const response = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "custom" },
        body: { input: { topic: "durability" }, name: "Custom" },
      }),
    );

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
    const workflow = defineWorkflow({ name: "approval" }, async (_event, step) => {
      const command = await waitForPiCommand(step, "approval");
      return {
        command: command.kind,
        text: command.kind === "prompt" ? command.input.text : null,
      };
    });
    harness = await buildHarness({ workflows: [workflow] });

    const response = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: "approval" },
        body: { input: {}, name: "Approval" },
      }),
    );

    await harness.workflows.runUntilIdle({
      workflowName: "approval",
      instanceId: response.data.id,
      reason: "create",
    });

    const events = assertJsonStream(
      await harness.fragments.pi.callRoute(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/events",
        {
          pathParams: { workflowName: response.data.workflowName, sessionId: response.data.id },
          query: { once: "true" },
        },
      ),
    );
    expect(await Array.fromAsync(events.stream)).toEqual([
      expect.objectContaining({ type: "snapshot" }),
    ]);

    const command = assertJson(
      await harness.fragments.pi.callRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        {
          pathParams: { workflowName: response.data.workflowName, sessionId: response.data.id },
          body: { kind: "prompt", input: { text: "approved" } },
        },
      ),
    );
    assert(command.data.accepted);

    await harness.workflows.runUntilIdle({
      workflowName: "approval",
      instanceId: response.data.id,
      reason: "event",
    });

    const detail = assertJson(
      await harness.fragments.pi.callRoute("GET", "/workflows/:workflowName/sessions/:sessionId", {
        pathParams: { workflowName: response.data.workflowName, sessionId: response.data.id },
      }),
    );
    expect(detail.data.workflow).toMatchObject({
      status: "complete",
      output: { command: "prompt", text: "approved" },
    });
  });

  it("creates a session with empty Pi state and no old public detail fields", async () => {
    const sessionId = await createSession();

    const detail = assertJson(
      await harness.fragments.pi.callRoute("GET", "/workflows/:workflowName/sessions/:sessionId", {
        pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
      }),
    );

    expect(detail.data.agent.state.messages).toEqual([]);
    expect(detail.data.agent.events).toEqual([]);
    expect(detail.data).not.toHaveProperty("trace");
    expect(detail.data).not.toHaveProperty("turns");
    expect(detail.data).not.toHaveProperty("commandHistory");
    expect(detail.data).not.toHaveProperty("phase");
    expect(detail.data).not.toHaveProperty("turn");
    expect(detail.data).not.toHaveProperty("waitingFor");
  });

  it("projects completed prompt messages into session detail", async () => {
    const sessionId = await createSession();
    await runSessionUntilIdle(sessionId, "create");

    const command = assertJson(
      await harness.fragments.pi.callRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
          body: { kind: "prompt", input: { text: "hello" } },
        },
      ),
    );
    assert(command.data.accepted);

    await drainDurableHooks(harness.workflows.fragment);
    await runSessionUntilIdle(sessionId);

    const detail = assertJson(
      await harness.fragments.pi.callRoute("GET", "/workflows/:workflowName/sessions/:sessionId", {
        pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
      }),
    );

    expect(textMessages(detail.data.agent.state.messages, "user")).toEqual(["hello"]);
    expect(textMessages(detail.data.agent.state.messages, "assistant")).toEqual(["assistant:init"]);
    expect(detail.data.agent.events).toEqual([]);
  });

  it("returns 404 from /events when the Pi session row is missing", async () => {
    const sessionId = await harness.workflows.createInstance(interactiveChatWorkflow.name, {
      params: { harnessName: "default" },
    });

    const response = assertError(
      await harness.fragments.pi.callRoute(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/events",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
        },
      ),
    );

    assert(response.status === 404);
    assert(response.error.code === "SESSION_NOT_FOUND");
  });

  it("streams an initial snapshot from /events", async () => {
    const sessionId = await createSession();

    const stream = assertJsonStream(
      await harness.fragments.pi.callRoute(
        "GET",
        "/workflows/:workflowName/sessions/:sessionId/events",
        {
          pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
        },
      ),
    );

    const frames: unknown[] = [];
    for await (const frame of stream.stream) {
      frames.push(frame);
      break;
    }
    await stream.stream.return(undefined);

    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "snapshot",
        state: expect.objectContaining({ messages: [] }),
      }),
    );
  });
});
