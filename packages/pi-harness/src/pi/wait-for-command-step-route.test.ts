import { afterEach, beforeEach, describe, expect, it, assert } from "vitest";

import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { createModelsForStreamFn } from "./harness/test-models";
import { buildHarness, createAssistantMessage, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { createInteractiveChatWorkflow } from "./workflows/interactive-chat-workflow";

type TestHarness = Awaited<ReturnType<typeof buildHarness>>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Command step did not settle.")), 2_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function assertJson<T extends { type: string }>(response: T): Extract<T, { type: "json" }> {
  assert(response.type === "json");
  return response as Extract<T, { type: "json" }>;
}

function assertError<T extends { type: string }>(response: T): Extract<T, { type: "error" }> {
  assert(response.type === "error");
  return response as Extract<T, { type: "error" }>;
}

function textStream(text: string, waitBeforeEnd: Promise<unknown>): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = createAssistantMessage(text);
    void (async () => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      await waitBeforeEnd;
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

describe("pi-harness wait-for-command-step route", () => {
  let harness: TestHarness;
  let workflow: ReturnType<typeof createInteractiveChatWorkflow>;
  let releaseAssistant: ReturnType<typeof deferred>;

  async function setup(
    options: {
      workflowsNamespace?: string;
      piNamespace?: string;
      rejectOperation?: boolean;
    } = {},
  ) {
    workflow = createInteractiveChatWorkflow({
      ...(options.rejectOperation
        ? {
            beforeOperation: () => {
              throw new NonRetryableError("COMMAND_REJECTED");
            },
          }
        : {}),
      options: {
        systemPrompt: "You are helpful.",
        model: mockModel,
        models: createModelsForStreamFn(
          mockModel,
          textStream("final answer", releaseAssistant.promise),
        ),
      },
    });
    const config: PiFragmentConfig = { workflows: [workflow] };
    harness = await buildHarness(config, {
      autoTickHooks: false,
      workflowsNamespace: options.workflowsNamespace,
      piNamespace: options.piNamespace,
    });
  }

  beforeEach(async () => {
    releaseAssistant = deferred();
    await setup();
  });

  afterEach(async () => {
    releaseAssistant.resolve();
    await harness.test.cleanup();
  });

  async function createSession() {
    const created = assertJson(
      await harness.fragments.pi.callRoute("POST", "/workflows/:workflowName/sessions", {
        pathParams: { workflowName: workflow.name },
        body: { name: "Pi Session", input: { profileName: "default" } },
      }),
    );
    const sessionId = created.data.id;
    await harness.workflows.getStatus(workflow.name, sessionId);
    await harness.workflows.runUntilIdle(
      { workflowName: workflow.name, instanceId: sessionId, reason: "create" },
      { maxTicks: 1 },
    );
    return sessionId;
  }

  async function sendPrompt(sessionId: string, text: string) {
    const response = assertJson(
      await harness.fragments.pi.callRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        {
          pathParams: { workflowName: workflow.name, sessionId },
          body: { kind: "prompt", input: { text } },
        },
      ),
    );
    return response.data.commandId;
  }

  function waitForCommand(sessionId: string, commandId: string, timeoutMs = 2_000) {
    return harness.fragments.pi.callRoute(
      "GET",
      "/workflows/:workflowName/sessions/:sessionId/commands/:commandId/wait",
      {
        pathParams: { workflowName: workflow.name, sessionId, commandId },
        query: { timeoutMs: String(timeoutMs) },
      },
    );
  }

  it("waits for the command step commit before acknowledging completion", async () => {
    const sessionId = await createSession();
    const commandId = await sendPrompt(sessionId, "hello");
    let waitSettled = false;
    const wait = waitForCommand(sessionId, commandId).then((result) => {
      waitSettled = true;
      return result;
    });
    const run = harness.workflows.runUntilIdle(
      { workflowName: workflow.name, instanceId: sessionId, reason: "event" },
      { maxTicks: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(!waitSettled);
    releaseAssistant.resolve();
    await run;

    const response = await withTimeout(wait);
    assert(response.type === "empty" && response.status === 204);
  });

  it("uses the Workflows namespace when Pi and Workflows share a namespaced database", async () => {
    await harness.test.cleanup();
    await setup({ workflowsNamespace: "custom-workflows", piNamespace: "custom-pi" });
    const sessionId = await createSession();
    const commandId = await sendPrompt(sessionId, "hello namespaced");
    const wait = waitForCommand(sessionId, commandId);
    const run = harness.workflows.runUntilIdle(
      { workflowName: workflow.name, instanceId: sessionId, reason: "event" },
      { maxTicks: 1 },
    );
    releaseAssistant.resolve();
    await run;
    const response = await withTimeout(wait);
    assert(response.type === "empty" && response.status === 204);
  });

  it("finds a fast command even when the wait starts after it has committed", async () => {
    const sessionId = await createSession();
    const commandId = await sendPrompt(sessionId, "hello fast");
    releaseAssistant.resolve();
    await harness.workflows.runUntilIdle(
      { workflowName: workflow.name, instanceId: sessionId, reason: "event" },
      { maxTicks: 1 },
    );
    const response = await withTimeout(waitForCommand(sessionId, commandId));
    assert(response.type === "empty" && response.status === 204);
  });

  it("times out when the command has not reached a settled step", async () => {
    const sessionId = await createSession();
    const commandId = await sendPrompt(sessionId, "queued");
    const response = assertError(await waitForCommand(sessionId, commandId, 5));
    assert(response.status === 408);
    assert(response.error.code === "COMMAND_STEP_TIMEOUT");
  });

  it.each([
    { kind: "skill" as const, input: { name: "unused" } },
    { kind: "promptFromTemplate" as const, input: { name: "unused" } },
    { kind: "compact" as const, input: { customInstructions: "unused" } },
  ])("waits for an accepted $kind command to reach its durable step", async (body) => {
    const sessionId = await createSession();
    const accepted = assertJson(
      await harness.fragments.pi.callRoute(
        "POST",
        "/workflows/:workflowName/sessions/:sessionId/command",
        { pathParams: { workflowName: workflow.name, sessionId }, body },
      ),
    );
    assert(accepted.data.commandId.startsWith(`${body.kind}_`));
    const wait = assertError(await waitForCommand(sessionId, accepted.data.commandId, 5));
    assert(wait.status === 408);
    assert(wait.error.code === "COMMAND_STEP_TIMEOUT");
  });

  it.each(["abort", "steer", "followUp"] as const)(
    "rejects waiting on an accepted %s control command without polling",
    async (kind) => {
      const sessionId = await createSession();
      const response = assertJson(
        await harness.fragments.pi.callRoute(
          "POST",
          "/workflows/:workflowName/sessions/:sessionId/command",
          {
            pathParams: { workflowName: workflow.name, sessionId },
            body: kind === "abort" ? { kind } : { kind, input: { text: "control input" } },
          },
        ),
      );
      expect(response.data.commandId).toMatch(new RegExp(`^${kind}_`, "u"));
      const wait = assertError(
        await withTimeout(waitForCommand(sessionId, response.data.commandId)),
      );
      assert(wait.status === 400);
      assert(wait.error.code === "COMMAND_NOT_WAITABLE");

      if (kind !== "abort") {
        releaseAssistant.resolve();
        await harness.workflows.runUntilIdle(
          { workflowName: workflow.name, instanceId: sessionId, reason: "event" },
          { maxTicks: 1 },
        );
        const afterFallback = assertError(await waitForCommand(sessionId, response.data.commandId));
        assert(afterFallback.status === 400);
        assert(afterFallback.error.code === "COMMAND_NOT_WAITABLE");
      }
    },
  );

  it("reports terminal command step errors rather than returning a stale assistant response", async () => {
    await harness.test.cleanup();
    await setup({ rejectOperation: true });
    const sessionId = await createSession();
    const commandId = await sendPrompt(sessionId, "reject this command");
    await harness.workflows.runUntilIdle(
      { workflowName: workflow.name, instanceId: sessionId, reason: "event" },
      { maxTicks: 1 },
    );

    const response = assertError(await waitForCommand(sessionId, commandId));
    assert(response.status === 409);
    assert(response.error.code === "COMMAND_STEP_FAILED");
    expect(response.error.message).toContain("COMMAND_REJECTED");
  });

  it("reports when an instance terminates before its command step starts", async () => {
    const sessionId = await createSession();
    const commandId = await sendPrompt(sessionId, "queued");
    await harness.workflows.terminateInstance(workflow.name, sessionId);

    const response = assertError(await waitForCommand(sessionId, commandId));
    assert(response.status === 409);
    assert(response.error.code === "COMMAND_WORKFLOW_TERMINAL");
  });

  it("rejects invalid command ids at the route boundary", async () => {
    const sessionId = await createSession();
    for (const commandId of ["not#a-command", "unknown_abc", "legacy-command-1"]) {
      const response = assertError(await waitForCommand(sessionId, commandId));
      assert(response.status === 400);
      assert(response.error.code === "INVALID_COMMAND_ID");
    }
  });

  it("returns SESSION_NOT_FOUND for missing instances", async () => {
    const response = assertError(await waitForCommand("missing-session", "prompt_command-1", 5));
    assert(response.status === 404);
    assert(response.error.code === "SESSION_NOT_FOUND");
  });
});
