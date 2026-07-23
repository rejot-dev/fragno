import { afterEach, beforeEach, describe, expect, it, assert, vi } from "vitest";

import { createId } from "@fragno-dev/db/id";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { drainDurableHooks } from "@fragno-dev/test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { waitForPiCommand } from "./harness/commands";
import {
  buildHarness,
  createAssistantMessage,
  createHarnessOptions,
  createTextStreamFn,
} from "./pi-test-utils";
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

  it("loads custom workflow status and commands through the session workflow name", async () => {
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
    expect(detail.data).not.toHaveProperty("trace");
    expect(detail.data).not.toHaveProperty("turns");
    expect(detail.data).not.toHaveProperty("commandHistory");
    expect(detail.data).not.toHaveProperty("phase");
    expect(detail.data).not.toHaveProperty("turn");
    expect(detail.data).not.toHaveProperty("waitingFor");
  });

  it("passes the workflow actor to onOperationCompleted after a successful operation", async () => {
    await harness.test.cleanup();
    const actor = { type: "account", id: "account-123" };
    const usage = {
      input: 120,
      output: 30,
      cacheRead: 40,
      cacheWrite: 10,
      totalTokens: 200,
      cost: {
        input: 0.0012,
        output: 0.0006,
        cacheRead: 0.00004,
        cacheWrite: 0.00002,
        total: 0.00186,
      },
    };
    const previousAssistantMessage = createAssistantMessage("previous response");
    previousAssistantMessage.usage = {
      input: 999,
      output: 999,
      cacheRead: 999,
      cacheWrite: 999,
      totalTokens: 3996,
      cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 },
    };
    const onOperationCompleted = vi.fn();
    interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: {
        default: createHarnessOptions({
          streamFn: createTextStreamFn("metered response", usage),
        }),
      },
    });
    harness = await buildHarness({
      workflows: [interactiveChatWorkflow],
      onOperationCompleted,
    });

    const created = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: interactiveChatWorkflow.name },
        body: {
          name: "Metered session",
          input: {
            harnessName: "default",
            actor,
            initialMessages: [previousAssistantMessage],
          },
        },
      }),
    );
    await runSessionUntilIdle(created.data.id, "create");

    await harness.fragments.pi.callRoute(
      "POST",
      "/workflows/:workflowName/sessions/:sessionId/command",
      {
        pathParams: { workflowName: interactiveChatWorkflow.name, sessionId: created.data.id },
        body: { kind: "prompt", input: { text: "measure this" } },
      },
    );
    await runSessionUntilIdle(created.data.id);
    await drainDurableHooks(harness.fragments.pi.fragment);

    expect(onOperationCompleted).toHaveBeenCalledTimes(1);
    expect(onOperationCompleted).toHaveBeenCalledWith(
      {
        actor,
        workflowName: interactiveChatWorkflow.name,
        sessionId: created.data.id,
        agentName: "default",
        stepName: expect.stringMatching(/^command:/),
        operationId: expect.stringContaining(created.data.id),
        operation: "prompt",
        modelCalls: [
          expect.objectContaining({
            api: "openai-responses",
            provider: "openai",
            model: "test-model",
            stopReason: "stop",
            usage,
          }),
        ],
        usage,
      },
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        hookId: expect.any(Object),
      }),
    );

    await runSessionUntilIdle(created.data.id);
    await drainDurableHooks(harness.fragments.pi.fragment);
    expect(onOperationCompleted).toHaveBeenCalledTimes(1);
  });

  it("records provider usage from a failed operation", async () => {
    await harness.test.cleanup();
    const usage = {
      input: 50,
      output: 5,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 65,
      cost: {
        input: 0.0005,
        output: 0.0001,
        cacheRead: 0.00001,
        cacheWrite: 0,
        total: 0.00061,
      },
    };
    const onOperationCompleted = vi.fn();
    interactiveChatWorkflow = createInteractiveChatWorkflow({
      harnesses: {
        default: createHarnessOptions({
          streamFn: () => {
            const stream = createAssistantMessageEventStream();
            const message = createAssistantMessage("");
            message.stopReason = "error";
            message.errorMessage = "provider failed";
            message.usage = usage;
            stream.push({ type: "error", reason: "error", error: message });
            return stream;
          },
        }),
      },
    });
    harness = await buildHarness({
      workflows: [interactiveChatWorkflow],
      onOperationCompleted,
    });

    const sessionId = await createSession();
    await runSessionUntilIdle(sessionId, "create");
    await harness.fragments.pi.callRoute(
      "POST",
      "/workflows/:workflowName/sessions/:sessionId/command",
      {
        pathParams: { workflowName: interactiveChatWorkflow.name, sessionId },
        body: { kind: "prompt", input: { text: "fail" } },
      },
    );
    await runSessionUntilIdle(sessionId);
    await drainDurableHooks(harness.fragments.pi.fragment);

    expect(onOperationCompleted).toHaveBeenCalledOnce();
    expect(onOperationCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        modelCalls: [expect.objectContaining({ stopReason: "error", usage })],
        usage,
      }),
      expect.any(Object),
    );
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
  });
});
