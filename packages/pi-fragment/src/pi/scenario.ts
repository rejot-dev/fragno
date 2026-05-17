import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { buildHarness, findWorkflowInstances, mockModel } from "./test-utils";
import type { PiFragmentConfig, PiPromptInput, PiSessionDetail } from "./types";
import { PI_WORKFLOW_NAME, type PiAgentRunner } from "./workflow/workflow";

export type PiScenarioVars = Record<string, unknown>;

type ScenarioInput<T, TVars extends PiScenarioVars> =
  | T
  | ((ctx: PiScenarioContext<TVars>) => T | Promise<T>);

export type ScriptedAgentInjection =
  | { kind: "abort"; at: Date }
  | { kind: "steer"; input: PiPromptInput; at: Date }
  | { kind: "followUp"; input: PiPromptInput; at: Date };

export type ScriptedAgentCheckpoint = {
  name: string;
  reachedAt: Date;
};

type ScriptedAgentRuntime = {
  runner: PiAgentRunner;
  waitForCheckpoint: (name: string) => Promise<void>;
  releaseCheckpoint: (name: string) => void;
  releaseAll: () => void;
  injections: () => ScriptedAgentInjection[];
  checkpoints: () => ScriptedAgentCheckpoint[];
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const assistantMessage = (text: string): Extract<AgentMessage, { role: "assistant" }> => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const userMessage = (input: PiPromptInput): Extract<AgentMessage, { role: "user" }> => ({
  role: "user",
  content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
  timestamp: Date.now(),
});

export const createCheckpointScriptedAgent = (checkpointNames: string[]): ScriptedAgentRuntime => {
  const reached = new Map<string, ReturnType<typeof createDeferred>>();
  const releases = new Map<string, ReturnType<typeof createDeferred>>();
  const injectionLog: ScriptedAgentInjection[] = [];
  const checkpointLog: ScriptedAgentCheckpoint[] = [];

  const getReached = (name: string) => {
    let deferred = reached.get(name);
    if (!deferred) {
      deferred = createDeferred();
      reached.set(name, deferred);
    }
    return deferred;
  };

  const getRelease = (name: string) => {
    let deferred = releases.get(name);
    if (!deferred) {
      deferred = createDeferred();
      releases.set(name, deferred);
    }
    return deferred;
  };

  const runner: PiAgentRunner = async (options) => {
    let aborted = false;
    const messages = [...options.messages];
    if (options.promptInput) {
      messages.push(userMessage(options.promptInput));
    }

    options.onController?.({
      abort: () => {
        aborted = true;
        injectionLog.push({ kind: "abort", at: new Date() });
      },
      steer: (input) => {
        injectionLog.push({ kind: "steer", input, at: new Date() });
      },
      followUp: (input) => {
        messages.push(userMessage(input));
        injectionLog.push({ kind: "followUp", input, at: new Date() });
      },
    });

    try {
      for (const name of checkpointNames) {
        if (aborted) {
          break;
        }
        checkpointLog.push({ name, reachedAt: new Date() });
        getReached(name).resolve();
        await getRelease(name).promise;
      }
    } finally {
      options.onControllerClear?.();
    }

    if (aborted) {
      return {
        outcome: "aborted",
        messages,
        events: [],
        errorMessage: "aborted by scripted agent",
      };
    }

    const assistant = assistantMessage("scripted agent completed");
    messages.push(assistant);
    return {
      outcome: "completed",
      messages,
      events: [],
      errorMessage: null,
    };
  };

  return {
    runner,
    waitForCheckpoint: async (name) => {
      await Promise.race([
        getReached(name).promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out waiting for checkpoint ${name}`)), 1000),
        ),
      ]);
    },
    releaseCheckpoint: (name) => getRelease(name).resolve(),
    releaseAll: () => {
      for (const name of checkpointNames) {
        getRelease(name).resolve();
      }
    },
    injections: () => [...injectionLog],
    checkpoints: () => [...checkpointLog],
  };
};

export type PiScenarioContext<TVars extends PiScenarioVars = PiScenarioVars> = {
  name: string;
  vars: Partial<TVars>;
  harness: Awaited<ReturnType<typeof buildHarness>>;
  agent: ScriptedAgentRuntime;
  background: Map<string, Promise<unknown>>;
  cleanup: () => Promise<void>;
  detail: (sessionId: string) => Promise<PiSessionDetail>;
  workflowStatus: (sessionId: string) => Promise<unknown>;
  assertStopped: (sessionId: string) => Promise<PiSessionDetail>;
};

export type PiScenarioStep<TVars extends PiScenarioVars> =
  | { type: "createSession"; agent?: string; name?: string; storeAs: keyof TVars & string }
  | {
      type: "prompt";
      sessionId: ScenarioInput<string, TVars>;
      text: string;
      storeAs?: keyof TVars & string;
    }
  | {
      type: "steer";
      sessionId: ScenarioInput<string, TVars>;
      text: string;
      storeAs?: keyof TVars & string;
    }
  | {
      type: "abort";
      sessionId: ScenarioInput<string, TVars>;
      reason?: string;
      storeAs?: keyof TVars & string;
    }
  | { type: "runAgentInBackground"; sessionId: ScenarioInput<string, TVars>; storeAs: string }
  | { type: "waitForCheckpoint"; name: string }
  | { type: "waitForInjection"; kind: ScriptedAgentInjection["kind"] }
  | { type: "releaseCheckpoint"; name: string }
  | { type: "releaseAll" }
  | { type: "awaitBackground"; name: string }
  | { type: "assert"; assert: (ctx: PiScenarioContext<TVars>) => void | Promise<void> };

export type PiScenarioDefinition<TVars extends PiScenarioVars = PiScenarioVars> = {
  name: string;
  checkpoints: string[];
  steps: PiScenarioStep<TVars>[];
};

type StepInput<TStep extends { type: string }> = Omit<TStep, "type">;

export const piSteps = <TVars extends PiScenarioVars = PiScenarioVars>() => ({
  createSession: (input: StepInput<Extract<PiScenarioStep<TVars>, { type: "createSession" }>>) =>
    ({ type: "createSession", ...input }) as PiScenarioStep<TVars>,
  prompt: (input: StepInput<Extract<PiScenarioStep<TVars>, { type: "prompt" }>>) =>
    ({ type: "prompt", ...input }) as PiScenarioStep<TVars>,
  steer: (input: StepInput<Extract<PiScenarioStep<TVars>, { type: "steer" }>>) =>
    ({ type: "steer", ...input }) as PiScenarioStep<TVars>,
  abort: (input: StepInput<Extract<PiScenarioStep<TVars>, { type: "abort" }>>) =>
    ({ type: "abort", ...input }) as PiScenarioStep<TVars>,
  runAgentInBackground: (
    input: StepInput<Extract<PiScenarioStep<TVars>, { type: "runAgentInBackground" }>>,
  ) => ({ type: "runAgentInBackground", ...input }) as PiScenarioStep<TVars>,
  waitForCheckpoint: (name: string) =>
    ({ type: "waitForCheckpoint", name }) as PiScenarioStep<TVars>,
  waitForInjection: (kind: ScriptedAgentInjection["kind"]) =>
    ({ type: "waitForInjection", kind }) as PiScenarioStep<TVars>,
  releaseCheckpoint: (name: string) =>
    ({ type: "releaseCheckpoint", name }) as PiScenarioStep<TVars>,
  releaseAll: () => ({ type: "releaseAll" }) as PiScenarioStep<TVars>,
  awaitBackground: (name: string) => ({ type: "awaitBackground", name }) as PiScenarioStep<TVars>,
  assert: (assert: Extract<PiScenarioStep<TVars>, { type: "assert" }>["assert"]) =>
    ({ type: "assert", assert }) as PiScenarioStep<TVars>,
});

export const definePiScenario = <TVars extends PiScenarioVars>(
  scenario: PiScenarioDefinition<TVars>,
) => scenario;

const resolveInput = async <T, TVars extends PiScenarioVars>(
  input: ScenarioInput<T, TVars>,
  ctx: PiScenarioContext<TVars>,
): Promise<T> =>
  typeof input === "function"
    ? await (input as (ctx: PiScenarioContext<TVars>) => T | Promise<T>)(ctx)
    : input;

const expectPoll = async (predicate: () => boolean, timeoutMessage: string) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(timeoutMessage);
};

export const runPiScenario = async <TVars extends PiScenarioVars>(
  scenario: PiScenarioDefinition<TVars>,
) => {
  const agent = createCheckpointScriptedAgent(scenario.checkpoints);
  const config: PiFragmentConfig = {
    agents: {
      scripted: {
        name: "scripted",
        systemPrompt: "You are a scripted test agent.",
        model: mockModel,
      },
    },
    tools: {},
  };
  const harness = await buildHarness(config, {
    autoTickHooks: false,
    agentRunner: agent.runner,
  });
  const ctx: PiScenarioContext<TVars> = {
    name: scenario.name,
    vars: {},
    harness,
    agent,
    background: new Map(),
    cleanup: harness.test.cleanup,
    detail: async (sessionId) => {
      const response = await harness.fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });
      if (response.type !== "json") {
        throw new Error(`Expected session detail json response, got ${response.type}`);
      }
      return response.data as PiSessionDetail;
    },
    workflowStatus: async (sessionId) =>
      await harness.workflows.getStatus(PI_WORKFLOW_NAME, sessionId),
    assertStopped: async (sessionId) => {
      const detail = await ctx.detail(sessionId);
      const status = await ctx.workflowStatus(sessionId);
      const workflowStatus =
        typeof status === "object" && status !== null
          ? (status as { status?: unknown }).status
          : undefined;
      if (workflowStatus !== "active" && workflowStatus !== "waiting") {
        throw new Error(
          `Expected workflow for session ${sessionId} to remain open after stop, got ${JSON.stringify(status)}.`,
        );
      }
      return detail;
    },
  };

  try {
    for (const step of scenario.steps) {
      switch (step.type) {
        case "createSession": {
          const response = await harness.fragments.pi.callRoute("POST", "/sessions", {
            body: { agent: step.agent ?? "scripted", name: step.name ?? scenario.name },
          });
          if (response.type !== "json") {
            throw new Error(`Expected create session json response, got ${response.type}`);
          }
          const sessionId = response.data.id;
          (ctx.vars as Record<string, unknown>)[step.storeAs] = sessionId;
          const [instance] = (await findWorkflowInstances(harness.workflows.test.adapter)).filter(
            (row) => row.workflowName === PI_WORKFLOW_NAME && row.id.toString() === sessionId,
          );
          if (!instance) {
            throw new Error(`Workflow instance for session ${sessionId} was not created.`);
          }
          await harness.workflows.runUntilIdle(
            {
              workflowName: PI_WORKFLOW_NAME,
              instanceId: sessionId,
              instanceRef: String(instance.id),
              reason: "create",
            },
            { maxTicks: 1 },
          );
          break;
        }
        case "prompt":
        case "steer": {
          const sessionId = await resolveInput(step.sessionId, ctx);
          const response = await harness.fragments.pi.callRoute(
            "POST",
            "/sessions/:sessionId/command",
            {
              pathParams: { sessionId },
              body: { kind: step.type, input: { text: step.text } },
            },
          );
          if (step.storeAs) {
            (ctx.vars as Record<string, unknown>)[step.storeAs] = response;
          }
          break;
        }
        case "abort": {
          const sessionId = await resolveInput(step.sessionId, ctx);
          const response = await harness.fragments.pi.callRoute(
            "POST",
            "/sessions/:sessionId/command",
            {
              pathParams: { sessionId },
              body: { kind: "abort", reason: step.reason },
            },
          );
          if (step.storeAs) {
            (ctx.vars as Record<string, unknown>)[step.storeAs] = response;
          }
          break;
        }
        case "runAgentInBackground": {
          const sessionId = await resolveInput(step.sessionId, ctx);
          const [instance] = (await findWorkflowInstances(harness.workflows.test.adapter)).filter(
            (row) => row.workflowName === PI_WORKFLOW_NAME && row.id.toString() === sessionId,
          );
          if (!instance) {
            throw new Error(`Workflow instance for session ${sessionId} was not created.`);
          }
          ctx.background.set(
            step.storeAs,
            harness.workflows.runUntilIdle({
              workflowName: PI_WORKFLOW_NAME,
              instanceId: sessionId,
              instanceRef: String(instance.id),
              reason: "event",
            }),
          );
          break;
        }
        case "waitForCheckpoint":
          await agent.waitForCheckpoint(step.name);
          break;
        case "waitForInjection": {
          await expectPoll(
            () => agent.injections().some((injection) => injection.kind === step.kind),
            `Timed out waiting for ${step.kind} injection`,
          );
          break;
        }
        case "releaseCheckpoint":
          agent.releaseCheckpoint(step.name);
          break;
        case "releaseAll":
          agent.releaseAll();
          break;
        case "awaitBackground":
          await ctx.background.get(step.name);
          break;
        case "assert":
          await step.assert(ctx);
          break;
      }
    }
  } catch (error) {
    agent.releaseAll();
    throw error;
  }

  return ctx;
};
