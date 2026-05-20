import { assert, describe, expect, test, vi } from "vitest";

import {
  defineScenario,
  runScenario,
  type WorkflowScenarioStepRow,
} from "@fragno-dev/workflows/scenario";

import { instantiate } from "@fragno-dev/core";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

import { createPiFragmentClient } from "../client/vanilla";
import { piRoutesFactory } from "../routes";
import { piFragmentDefinition } from "./definition";
import { mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { createPiWorkflows } from "./workflow/workflow";

const createAssistantMessage = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: stopReason }],
  api: mockModel.api,
  provider: mockModel.provider,
  model: mockModel.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: Date.now(),
});

describe("Pi workflow scenarios", () => {
  test("aborts an in-flight agent stream", async () => {
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    const abortObserved = vi.fn();

    const streamFn: StreamFn = (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      markStreamStarted();

      const completeAsAborted = () => {
        abortObserved();
        const message = createAssistantMessage("aborted");
        stream.push({ type: "done", reason: "stop", message });
      };

      if (options?.signal?.aborted) {
        completeAsAborted();
      } else {
        options?.signal?.addEventListener("abort", completeAsAborted, { once: true });
      }

      return stream;
    };

    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn,
        },
      },
      tools: {},
    };
    await runScenario(
      defineScenario({
        name: "pi-agent-abort",
        workflows: createPiWorkflows({ agents: config.agents, tools: config.tools }),
        vars: () => ({
          sessionId: undefined as string | undefined,
          steps: undefined as WorkflowScenarioStepRow[] | undefined,
        }),
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withRoutes([piRoutesFactory])
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        clients: ({ clientConfig }) => ({
          agent: createPiFragmentClient(clientConfig("pi", { runner: "agent" })),
          user: createPiFragmentClient(clientConfig("pi", { runner: "user" })),
        }),
        stores: ({ clients, store }) => ({
          agentSession: store((ctx) =>
            clients.agent.useSession({ path: { sessionId: ctx.vars.sessionId! } }),
          ),
          userSession: store((ctx) =>
            clients.user.useSession({ path: { sessionId: ctx.vars.sessionId! } }),
          ),
        }),
        runners: ["agent", "user"],
        steps: ({ workflow, runners, concurrent, clients, stores }) => [
          workflow.read({
            read: async () => {
              const session = await clients.user.useCreateSession().mutate({
                body: { agent: "default", name: "Scenario Session" },
              });
              assert(session && !Array.isArray(session), "expected session response");
              return session.id;
            },
            storeAs: "sessionId",
          }),
          runners.agent.runUntilIdle({
            workflow: "agentLoop",
            instanceId: (ctx) => ctx.vars.sessionId!,
            reason: "create",
          }),
          stores.agentSession.waitFor(
            (state) => state.connectionStatus === "open" && state.agent !== null,
          ),
          stores.userSession.waitFor(
            (state) => state.connectionStatus === "open" && state.agent !== null,
          ),
          concurrent({
            agent: [
              stores.agentSession.read(async (session) => {
                await session.sendCommand({
                  kind: "prompt",
                  input: { text: "hello" },
                });
              }),
              runners.agent.runUntilIdle({
                workflow: "agentLoop",
                instanceId: (ctx) => ctx.vars.sessionId!,
                reason: "event",
              }),
            ],
            user: [
              workflow.read({ read: () => streamStarted }),
              stores.userSession.read(async (session) => {
                await session.sendCommand({ kind: "abort", reason: "test" });
              }),
            ],
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("agentLoop", ctx.vars.sessionId ?? ""),
            storeAs: "steps",
          }),
          stores.userSession.waitFor(
            (state) =>
              state.agent?.messages.some(
                (message) => message.role === "assistant" && message.stopReason === "aborted",
              ) ?? false,
            {
              assert: (sessionState) => {
                expect(sessionState.agent?.messages).toContainEqual(
                  expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
                );
              },
            },
          ),
          workflow.assert((ctx) => {
            assert(ctx.vars.sessionId, "sessionId should be set");
            expect(abortObserved).toHaveBeenCalledTimes(1);
            expect(ctx.vars.steps).toContainEqual(
              expect.objectContaining({
                name: "command-0-prompt",
                status: "completed",
                result: expect.objectContaining({ outcome: "aborted" }),
              }),
            );
          }),
        ],
      }),
    );
  });
});
