import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { workflowsFragmentDefinition } from "./definition";
import { createWorkflowsRunner } from "./runner";
import { defineWorkflow } from "./workflow";
import { workflowsRoutesFactory } from "./routes";
import { z } from "zod";

type FakeAgentMessage = { role: "system" | "user" | "assistant"; content: string };
type FakeAgentEvent =
  | { type: "agent_start" | "agent_end" }
  | { type: "message_start"; role: FakeAgentMessage["role"] }
  | { type: "message_end"; role: FakeAgentMessage["role"]; content: string };

const agentFailOnceTurns = new Set<string>();
const agentFailedTurns = new Set<string>();
const agentPromptCounts = new Map<string, number>();
const agentContinueCounts = new Map<string, number>();

const resetAgentSimulation = () => {
  agentFailOnceTurns.clear();
  agentFailedTurns.clear();
  agentPromptCounts.clear();
  agentContinueCounts.clear();
};

const recordPrompt = (turnKey: string | undefined) => {
  if (!turnKey) {
    return;
  }
  agentPromptCounts.set(turnKey, (agentPromptCounts.get(turnKey) ?? 0) + 1);
};

const recordContinue = (turnKey: string | undefined) => {
  if (!turnKey) {
    return;
  }
  agentContinueCounts.set(turnKey, (agentContinueCounts.get(turnKey) ?? 0) + 1);
};

const shouldFailPrompt = (turnKey: string | undefined) =>
  !!turnKey && agentFailOnceTurns.has(turnKey) && !agentFailedTurns.has(turnKey);

const markPromptFailed = (turnKey: string | undefined) => {
  if (!turnKey) {
    return;
  }
  agentFailedTurns.add(turnKey);
};

const getLastUserContent = (messages: FakeAgentMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      return messages[i]?.content ?? "";
    }
  }
  return "";
};

class FakeAgent {
  state: { systemPrompt: string; messages: FakeAgentMessage[] };
  #turnKey?: string;
  #subscribers = new Set<(event: FakeAgentEvent) => void>();

  constructor(options: {
    initialState: { systemPrompt: string; messages: FakeAgentMessage[] };
    turnKey?: string;
  }) {
    this.state = {
      systemPrompt: options.initialState.systemPrompt,
      messages: [...options.initialState.messages],
    };
    this.#turnKey = options.turnKey;
  }

  subscribe(handler: (event: FakeAgentEvent) => void) {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  #emit(event: FakeAgentEvent) {
    for (const handler of this.#subscribers) {
      handler(event);
    }
  }

  async prompt(text: string) {
    recordPrompt(this.#turnKey);
    this.#emit({ type: "agent_start" });
    this.#emit({ type: "message_start", role: "user" });
    this.state.messages.push({ role: "user", content: text });
    this.#emit({ type: "message_end", role: "user", content: text });

    if (shouldFailPrompt(this.#turnKey)) {
      markPromptFailed(this.#turnKey);
      this.#emit({ type: "agent_end" });
      throw new Error("AGENT_PROMPT_FAILED");
    }

    const assistant = { role: "assistant", content: `assistant:${text}` } as const;
    this.#emit({ type: "message_start", role: "assistant" });
    this.state.messages.push(assistant);
    this.#emit({ type: "message_end", role: "assistant", content: assistant.content });
    this.#emit({ type: "agent_end" });
    return assistant;
  }

  async continue() {
    recordContinue(this.#turnKey);
    this.#emit({ type: "agent_start" });
    const lastUser = getLastUserContent(this.state.messages);
    const assistant = { role: "assistant", content: `assistant:${lastUser}` } as const;
    this.#emit({ type: "message_start", role: "assistant" });
    this.state.messages.push(assistant);
    this.#emit({ type: "message_end", role: "assistant", content: assistant.content });
    this.#emit({ type: "agent_end" });
    return assistant;
  }
}

const agentLoopParamsSchema = z.object({
  systemPrompt: z.string().optional(),
  context: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .optional(),
});

const userMessageSchema = z.object({
  text: z.string().optional(),
  done: z.boolean().optional(),
});

const AgentLoopWorkflow = defineWorkflow(
  { name: "agent-loop-workflow", schema: agentLoopParamsSchema },
  async (event, step) => {
    const payload = event.payload;
    const systemPrompt = payload.systemPrompt ?? "You are a helpful assistant.";
    let messages: FakeAgentMessage[] = [
      { role: "system", content: systemPrompt },
      ...(payload.context ?? []),
    ];
    let turn = 0;

    while (true) {
      const userEvent = await step.waitForEvent(`user-${turn}`, {
        type: "user_message",
        timeout: "1 hour",
      });
      const eventPayload = userMessageSchema.parse(userEvent.payload ?? {});
      const userText = eventPayload.text ?? "";
      const turnKey = `${event.instanceId}:${turn}`;

      const turnResult = await step.do(
        `assistant-${turn}`,
        { retries: { limit: 1, delay: "10 ms", backoff: "constant" } },
        async () => {
          const shouldContinue = agentFailedTurns.has(turnKey);
          const agent = new FakeAgent({
            initialState: {
              systemPrompt,
              messages: shouldContinue
                ? [...messages, { role: "user", content: userText }]
                : messages,
            },
            turnKey,
          });
          const response = shouldContinue ? await agent.continue() : await agent.prompt(userText);
          return { assistant: response, messages: agent.state.messages };
        },
      );
      messages = turnResult.messages;

      if (eventPayload.done) {
        return { messages };
      }

      turn += 1;
    }
  },
);

describe("Agent Loop Workflow", () => {
  const workflows = {
    agentLoop: AgentLoopWorkflow,
  };

  const setup = async () => {
    const runtime = defaultFragnoRuntime;
    const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "workflows",
        instantiate(workflowsFragmentDefinition)
          .withConfig({
            workflows,
            runtime,
          })
          .withRoutes([workflowsRoutesFactory]),
      )
      .build();

    const { fragment, db } = fragments.workflows;
    const runner = createWorkflowsRunner({ fragment, workflows, runtime });
    return { fragment, db, runner, testContext };
  };

  let fragment: Awaited<ReturnType<typeof setup>>["fragment"];
  let db: Awaited<ReturnType<typeof setup>>["db"];
  let runner: Awaited<ReturnType<typeof setup>>["runner"];
  let testContext: Awaited<ReturnType<typeof setup>>["testContext"];

  beforeAll(async () => {
    ({ fragment, db, runner, testContext } = await setup());
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
    resetAgentSimulation();
  });

  const createInstance = async (workflowName: string, params: unknown) => {
    const response = await fragment.callRoute("POST", "/:workflowName/instances", {
      pathParams: { workflowName },
      body: { params },
    });
    if (response.type !== "json") {
      throw new Error("Expected json response");
    }
    return response.data.id as string;
  };

  test("replays context and continues after failures", async () => {
    vi.useFakeTimers();
    try {
      const id = await createInstance("agent-loop-workflow", {
        systemPrompt: "You are a helpful assistant.",
        context: [{ role: "user", content: "prior context" }],
      });

      const initialTick = await runner.tick({ maxInstances: 1, maxSteps: 20 });
      expect(initialTick).toBe(1);

      const waiting = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "agent-loop-workflow"), eb("instanceId", "=", id)),
        ),
      );
      expect(waiting?.status).toBe("waiting");

      agentFailOnceTurns.add(`${id}:0`);

      await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/events", {
        pathParams: { workflowName: "agent-loop-workflow", instanceId: id },
        body: { type: "user_message", payload: { text: "hi" } },
      });

      const failedTurn = await runner.tick({ maxInstances: 1, maxSteps: 20 });
      expect(failedTurn).toBe(1);

      const waitingAfterFailure = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "agent-loop-workflow"), eb("instanceId", "=", id)),
        ),
      );
      expect(waitingAfterFailure?.status).toBe("waiting");

      const [retryTask] = await db.find("workflow_task", (b) => b.whereIndex("primary"));
      if (retryTask?.runAt) {
        const nowMs = Date.now();
        const runAtMs = retryTask.runAt.getTime();
        if (runAtMs > nowMs) {
          await vi.advanceTimersByTimeAsync(runAtMs - nowMs + 1);
        }
      }

      const retriedTurn = await runner.tick({ maxInstances: 1, maxSteps: 20 });
      expect(retriedTurn).toBe(1);

      const waitingAfterRetry = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "agent-loop-workflow"), eb("instanceId", "=", id)),
        ),
      );
      expect(waitingAfterRetry?.status).toBe("waiting");

      await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/events", {
        pathParams: { workflowName: "agent-loop-workflow", instanceId: id },
        body: { type: "user_message", payload: { text: "bye", done: true } },
      });

      const secondTurn = await runner.tick({ maxInstances: 1, maxSteps: 20 });
      expect(secondTurn).toBe(1);

      const completed = await db.findFirst("workflow_instance", (b) =>
        b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
          eb.and(eb("workflowName", "=", "agent-loop-workflow"), eb("instanceId", "=", id)),
        ),
      );
      expect(completed?.status).toBe("complete");
      expect(completed?.output).toEqual({
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "prior context" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "assistant:hi" },
          { role: "user", content: "bye" },
          { role: "assistant", content: "assistant:bye" },
        ],
      });
      expect(agentPromptCounts.get(`${id}:0`)).toBe(1);
      expect(agentContinueCounts.get(`${id}:0`)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
