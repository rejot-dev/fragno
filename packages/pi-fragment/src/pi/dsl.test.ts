import { assert, describe, expect, expectTypeOf, it } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";
import { Type, type Static } from "typebox";
import { z } from "zod";

import { instantiate } from "@fragno-dev/core";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { piFragmentDefinition } from "./definition";
import {
  compilePiWorkflow,
  createPi,
  definePiTool,
  definePiWorkflow,
  type PiAgentDefinitionInput,
  type PiRuntime,
  type PiTool,
  type PiToolDefinition,
  type PiWorkflowDefinition,
} from "./dsl";
import { createPiWorkflows } from "./factory";
import { createAssistantStreamScript, mockModel } from "./pi-test-utils";
import type { PiFragmentConfig } from "./types";
import { projectSessionDetailFromWorkflowHistory } from "./workflow/reconstruct-session";
import { interactiveChatWorkflow } from "./workflows/interactive-chat-workflow";

describe("pi builder types", () => {
  it("preserves literal agent names and tool references", () => {
    const runtime = createPi()
      .withTool("grep", async () => {
        throw new Error("test tool should not execute");
      })
      .withAgent("reviewer", {
        systemPrompt: "You review code.",
        model: mockModel,
        tools: ["grep"],
      })
      .build();

    type ReviewerAgent = (typeof runtime.config.agents)["reviewer"];
    type ReviewerTools = NonNullable<ReviewerAgent["tools"]>;

    expectTypeOf(runtime.config.agents["reviewer"].name).toEqualTypeOf<"reviewer">();
    expectTypeOf<ReviewerTools[number]>().toEqualTypeOf<"grep">();
  });

  it("keeps registered agent and tool names in the runtime type", () => {
    const grepTool = (async () => {
      throw new Error("test tool should not execute");
    }) satisfies PiTool;
    const reviewerAgent = {
      systemPrompt: "You review code.",
      model: mockModel,
      tools: ["grep"],
    } satisfies PiAgentDefinitionInput<"grep">;

    const runtime = createPi()
      .withTool("grep", grepTool)
      .withAgent("reviewer", reviewerAgent)
      .build();

    const typedRuntime: PiRuntime<
      { reviewer: typeof reviewerAgent & { name: "reviewer" } },
      { grep: typeof grepTool }
    > = runtime;

    expectTypeOf<keyof typeof typedRuntime.config.agents>().toEqualTypeOf<"reviewer">();
    expectTypeOf<keyof typeof typedRuntime.config.tools>().toEqualTypeOf<"grep">();
  });

  it("requires agents to reference registered tool names", () => {
    const grepTool = (async () => {
      throw new Error("test tool should not execute");
    }) satisfies PiTool;

    createPi()
      .withTool("grep", grepTool)
      .withAgent("reviewer", {
        systemPrompt: "You review code.",
        model: mockModel,
        tools: ["grep"],
      });

    createPi()
      .withTool("grep", grepTool)
      .withAgent("reviewer", {
        systemPrompt: "You review code.",
        model: mockModel,
        // @ts-expect-error - missing is not in the registered tool names.
        tools: ["missing"],
      });

    createPi().withAgent("reviewer", {
      systemPrompt: "You review code.",
      model: mockModel,
      // @ts-expect-error - grep must be registered before an agent can reference it.
      tools: ["grep"],
    });
  });
});

describe("createPi builder", () => {
  it("builds config from individual agent and tool registrations", () => {
    const agent = {
      systemPrompt: "You are helpful.",
      model: mockModel,
    };
    const tool = (async () => {
      throw new Error("test tool should not execute");
    }) satisfies PiTool;

    const runtime = createPi().withTool("search", tool).withAgent("default", agent).build();

    expect(runtime.config.agents).toEqual({ default: { ...agent, name: "default" } });
    expect(runtime.config.tools).toEqual({ search: tool });
    expect(runtime.workflows).toEqual({});
  });

  it("lets later registrations replace earlier registrations with the same name", () => {
    const firstAgent = {
      systemPrompt: "First prompt.",
      model: mockModel,
    };
    const secondAgent = {
      systemPrompt: "Second prompt.",
      model: mockModel,
    };
    const firstTool = (async () => {
      throw new Error("first test tool should not execute");
    }) satisfies PiTool;
    const secondTool = (async () => {
      throw new Error("second test tool should not execute");
    }) satisfies PiTool;

    const runtime = createPi()
      .withAgent("default", firstAgent)
      .withAgent("default", secondAgent)
      .withTool("lookup", firstTool)
      .withTool("lookup", secondTool)
      .build();

    expectTypeOf(runtime.config.agents["default"]).toEqualTypeOf<
      typeof secondAgent & { name: "default" }
    >();
    expectTypeOf(runtime.config.tools["lookup"]).toEqualTypeOf<typeof secondTool>();
    expect(runtime.config.agents["default"]).toEqual({ ...secondAgent, name: "default" });
    expect(runtime.config.tools["lookup"]).toBe(secondTool);
  });

  it("snapshots registered agents and tools when build is called", () => {
    const builder = createPi();
    const originalAgent = {
      systemPrompt: "You are helpful.",
      model: mockModel,
    };
    const changedAgent = {
      systemPrompt: "Changed prompt.",
      model: mockModel,
    };
    const originalTool = (async () => {
      throw new Error("lookup test tool should not execute");
    }) satisfies PiTool;
    const changedTool = (async () => {
      throw new Error("changed test tool should not execute");
    }) satisfies PiTool;

    const runtime = builder
      .withAgent("default", originalAgent)
      .withTool("lookup", originalTool)
      .build();
    builder.withAgent("default", changedAgent).withTool("lookup", changedTool);

    expect(runtime.config.agents["default"]?.systemPrompt).toBe("You are helpful.");
    expect(runtime.config.tools["lookup"]).toBe(originalTool);
  });

  it("registers custom workflows alongside typed tools", () => {
    const tool = definePiTool({
      name: "classify",
      label: "Classify",
      description: "Classify a request.",
      parameters: Type.Object({ text: Type.String() }),
      resultSchema: z.object({ kind: z.enum(["question", "bug"]) }),
      execute: async () => ({
        content: [{ type: "text", text: "question" }],
        details: { kind: "question" as const },
      }),
    });
    const workflow = definePiWorkflow(
      { name: "triage", schema: z.object({ request: z.string() }) },
      (ctx) => ({ request: ctx.params.request }),
    );

    const runtime = createPi()
      .withTool("classify", tool)
      .withWorkflow(interactiveChatWorkflow)
      .withWorkflow(workflow)
      .build();

    expect(runtime.config.tools["classify"]).toBe(tool);
    expect(runtime.workflows).toHaveProperty(interactiveChatWorkflow.name);
    expect(runtime.workflows).toHaveProperty("triage");
  });

  it("lets later workflow registrations replace earlier registrations with the same name", () => {
    const first = definePiWorkflow({ name: "custom" }, () => "first");
    const second = definePiWorkflow({ name: "custom" }, () => "second");

    const runtime = createPi().withWorkflow(first).withWorkflow(second).build();

    expect(runtime.workflows["custom"]?.name).toBe("custom");
  });

  it("propagates logging config to runtime config and workflow initialization", () => {
    const runtime = createPi()
      .withAgent("default", {
        systemPrompt: "You are helpful.",
        model: mockModel,
      })
      .logging({ enabled: true, level: "debug" })
      .build();

    expect(runtime.config.logging).toEqual({ enabled: true, level: "debug" });
  });
});

describe("definePiWorkflow", () => {
  it("preserves name and schema metadata", () => {
    const schema = z.object({ topic: z.string() });
    const outputSchema = z.object({ finalAnswer: z.string() });

    const workflow = definePiWorkflow(
      { name: "research-then-write", schema, outputSchema },
      (ctx) => {
        return { finalAnswer: ctx.params.topic };
      },
    );

    expect(workflow.name).toBe("research-then-write");
    expect(workflow.schema).toBe(schema);
    expect(workflow.outputSchema).toBe(outputSchema);
  });

  it("infers params from the input schema", () => {
    definePiWorkflow(
      {
        name: "typed-params",
        schema: z.object({ topic: z.string(), limit: z.number().optional() }),
      },
      (ctx) => {
        expectTypeOf(ctx.params).toMatchObjectType<{ topic: string; limit?: number }>();
        return { topic: ctx.params.topic };
      },
    );
  });

  it("infers output from the output schema", () => {
    const workflow = definePiWorkflow(
      { name: "typed-output", outputSchema: z.object({ finalAnswer: z.string() }) },
      () => {
        return { finalAnswer: "done" };
      },
    );

    expectTypeOf(workflow).toExtend<
      PiWorkflowDefinition<"typed-output", unknown, { finalAnswer: string }>
    >();
  });

  it("compiles context primitives to workflow steps", async () => {
    const workflow = compilePiWorkflow(
      definePiWorkflow(
        { name: "pi-context-primitives", schema: z.object({ sessionId: z.string() }) },
        async (ctx) => {
          await ctx.step.do("emit-ready", (tx) => tx.emit({ type: "ready" }));
          const command = await ctx.waitForEvent("next-command", {
            allowed: ["prompt"],
            timeout: "1 hour",
          });
          await ctx.sleep("pause", "1 hour");
          return { sessionId: ctx.sessionId, commandKind: command.kind };
        },
      ),
    );

    await runScenario(
      defineScenario({
        name: "pi-context-primitives",
        workflows: { piContext: workflow },
        runners: ["worker"],
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({
            workflow: "piContext",
            id: "session-1",
            params: { sessionId: "session-1" },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getEmissions("piContext", "session-1"),
            assert: (emissions) => {
              expect(emissions).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    payload: { type: "ready" },
                    stepKey: "do:emit-ready",
                  }),
                ]),
              );
            },
          }),
          runners.worker.eventAndRunUntilIdle({
            workflow: "piContext",
            instanceId: "session-1",
            event: {
              type: "command",
              payload: { commandId: "command-1", kind: "prompt", input: { text: "go" } },
            },
          }),
          runners.worker.advanceTimeAndRunUntilIdle({
            workflow: "piContext",
            instanceId: "session-1",
            advanceBy: "1 hour",
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("piContext", "session-1"),
            assert: (status) => {
              assert(status.status === "complete");
              expect(status.output).toEqual({ sessionId: "session-1", commandKind: "prompt" });
            },
          }),
        ],
      }),
    );
  });

  it("ignores disallowed commands while waiting for an allowed command", async () => {
    const workflow = compilePiWorkflow(
      definePiWorkflow({ name: "pi-disallowed-command" }, async (ctx) => {
        const command = await ctx.waitForEvent("next-command", {
          allowed: ["prompt"],
        });
        return { commandKind: command.kind };
      }),
    );

    await runScenario(
      defineScenario({
        name: "pi-disallowed-command",
        workflows: { custom: workflow },
        runners: ["worker"],
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({
            workflow: "custom",
            id: "session-1",
          }),
          runners.worker.eventAndRunUntilIdle({
            workflow: "custom",
            instanceId: "session-1",
            event: {
              type: "command",
              // abort is not in the allowed list, so this should be ignored and not cause the workflow to fail.
              payload: { commandId: "abort-1", kind: "abort", reason: "test" },
            },
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("custom", "session-1"),
              steps: await ctx.state.getSteps("custom", "session-1"),
            }),
            assert: ({ status, steps }) => {
              expect(status.status).toBe("waiting");
              expect(steps).toEqual([
                expect.objectContaining({
                  status: "completed",
                  stepKey: "waitForEvent:next-command",
                }),
                expect.objectContaining({
                  status: "waiting",
                  stepKey: "waitForEvent:next-command-1",
                }),
              ]);
            },
          }),
          runners.worker.eventAndRunUntilIdle({
            workflow: "custom",
            instanceId: "session-1",
            event: {
              type: "command",
              payload: { commandId: "prompt-1", kind: "prompt", input: { text: "go" } },
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("custom", "session-1"),
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { commandKind: "prompt" },
              });
            },
          }),
        ],
      }),
    );
  });

  it("exposes all agent handle methods in workflow context types", () => {
    definePiWorkflow({ name: "agent-handle-types" }, (ctx) => {
      expectTypeOf(ctx.agent("agent").run).parameters.toExtend<
        [string, { mode: "prompt" | "continue" }]
      >();
      expectTypeOf(ctx.agent("agent").prompt).parameters.toExtend<
        [string, { input: { text: string } }]
      >();
      expectTypeOf(ctx.agent("agent").continue).parameters.toExtend<
        [string, { messages?: unknown[] }?]
      >();
    });
  });

  it("runs parallel custom workflow agent steps inside a named parent step", async () => {
    const securityScript = createAssistantStreamScript().text("security ok").build();
    const clarityScript = createAssistantStreamScript().text("clarity ok").build();
    const config: PiFragmentConfig = {
      agents: {
        security: {
          name: "security",
          systemPrompt: "Review security.",
          model: mockModel,
          streamFn: securityScript.streamFn,
        },
        clarity: {
          name: "clarity",
          systemPrompt: "Review clarity.",
          model: mockModel,
          streamFn: clarityScript.streamFn,
        },
      },
      tools: {},
    };
    const workflow = compilePiWorkflow(
      definePiWorkflow(
        { name: "pi-parallel-agents", schema: z.object({ draft: z.string() }) },
        async (ctx) => {
          const [security, clarity] = await ctx.step.do("parallel-reviews", () =>
            Promise.all([
              ctx.agent("security").prompt("security-review", {
                input: { text: `Security review: ${ctx.params.draft}` },
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: "security context" }],
                    timestamp: Date.now(),
                  },
                ],
              }),
              ctx.agent("clarity").prompt("clarity-review", {
                input: { text: `Clarity review: ${ctx.params.draft}` },
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: "clarity context" }],
                    timestamp: Date.now(),
                  },
                ],
              }),
            ]),
          );

          return {
            messageCount: security.messages.length + clarity.messages.length,
          };
        },
      ),
      { agents: config.agents, tools: config.tools },
    );

    await runScenario(
      defineScenario({
        name: "pi-parallel-agents",
        workflows: { custom: workflow },
        runners: ["worker"],
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({
            workflow: "custom",
            id: "parallel-session",
            params: { draft: "ship it" },
          }),
          workflow.read({
            read: async (ctx) => {
              const steps = await ctx.state.getSteps("custom", "parallel-session");
              return {
                status: await ctx.state.getStatus("custom", "parallel-session"),
                steps,
                reconstructed: projectSessionDetailFromWorkflowHistory({
                  cursorState: { turn: 0, phase: "complete", waitingFor: null },
                  steps,
                  events: [],
                }),
              };
            },
            assert: ({ status, steps, reconstructed }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { messageCount: 4 },
              });
              expect(steps.map((step) => step.stepKey)).toEqual([
                "do:parallel-reviews",
                "do:parallel-reviews>do:security-review",
                "do:parallel-reviews>do:clarity-review",
              ]);
              expect(reconstructed.messages).toHaveLength(4);
              expect(reconstructed.events.length).toBeGreaterThan(0);
            },
          }),
        ],
      }),
    );
  });

  it("adds custom definitions to the Pi workflows registry", () => {
    const workflow = definePiWorkflow({ name: "custom-workflow" }, () => ({ ok: true }));
    const registry = createPiWorkflows({ agents: {}, tools: {}, workflows: [workflow] });

    expect(registry).toHaveProperty("custom-workflow");
    expect(registry["custom-workflow"]?.name).toBe("custom-workflow");
  });

  it("rejects duplicate Pi workflow names", () => {
    const first = definePiWorkflow({ name: "duplicate" }, () => ({ ok: true }));
    const second = definePiWorkflow({ name: "duplicate" }, () => ({ ok: true }));

    expect(() => createPiWorkflows({ agents: {}, tools: {}, workflows: [first, second] })).toThrow(
      "Duplicate Pi workflow name 'duplicate'.",
    );
  });

  it("runs a custom workflow race inside a named parent step", async () => {
    const workflow = compilePiWorkflow(
      definePiWorkflow({ name: "pi-approval-race" }, async (ctx) => {
        const result = await ctx.step.do("approval-race", () =>
          Promise.race([
            ctx
              .waitForEvent("approval", {
                allowed: ["complete", "abort"],
              })
              .then((command) => ({ kind: command.kind })),
            ctx.step.do("timeout-branch", async () => {
              await ctx.sleep("approval-timeout", "2 hours");
              return { kind: "timeout" as const };
            }),
          ]),
        );
        return result;
      }),
    );

    await runScenario(
      defineScenario({
        name: "pi-approval-race",
        workflows: { custom: workflow },
        runners: ["worker"],
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({
            workflow: "custom",
            id: "approval-session",
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("custom", "approval-session"),
            assert: (steps) => {
              expect(steps.map((step) => step.stepKey)).toEqual([
                "do:approval-race",
                "do:approval-race>waitForEvent:approval",
                "do:approval-race>do:timeout-branch",
                "do:approval-race>do:timeout-branch>sleep:approval-timeout",
              ]);
            },
          }),

          runners.worker.eventAndRunUntilIdle({
            workflow: "custom",
            instanceId: "approval-session",
            event: {
              type: "command",
              payload: { commandId: "complete-1", kind: "complete" },
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("custom", "approval-session"),
            assert: (status) => {
              expect(status).toMatchObject({ status: "complete", output: { kind: "complete" } });
            },
          }),
        ],
      }),
    );
  });

  it("runs a custom workflow first-success step inside a named parent step", async () => {
    const workflow = compilePiWorkflow(
      definePiWorkflow({ name: "pi-first-success" }, async (ctx) => {
        const first = await ctx.step.do("first-success", () =>
          Promise.any([
            ctx.step.do("slow-branch", async () => {
              await ctx.sleep("ready-delay", "1 hour");
              return { kind: "slept" as const };
            }),
            ctx.step.do("fast-branch", async () => ({ kind: "fast" as const })),
          ]),
        );
        return first;
      }),
    );

    await runScenario(
      defineScenario({
        name: "pi-first-success",
        workflows: { custom: workflow },
        runners: ["worker"],
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({ workflow: "custom", id: "first-session" }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("custom", "first-session"),
              steps: await ctx.state.getSteps("custom", "first-session"),
            }),
            assert: ({ status, steps }) => {
              expect(status).toMatchObject({ status: "complete", output: { kind: "fast" } });
              expect(steps.map((step) => step.stepKey)).toEqual([
                "do:first-success",
                "do:first-success>do:slow-branch",
                "do:first-success>do:slow-branch>sleep:ready-delay",
                "do:first-success>do:fast-branch",
              ]);
            },
          }),
        ],
      }),
    );
  });

  it("runs sequential custom workflow agent steps", async () => {
    const researcherScript = createAssistantStreamScript().text("research notes").build();
    const writerScript = createAssistantStreamScript().text("draft answer").build();
    const reviewerScript = createAssistantStreamScript().text("reviewed answer").build();
    const config: PiFragmentConfig = {
      agents: {
        researcher: {
          name: "researcher",
          systemPrompt: "Research.",
          model: mockModel,
          streamFn: researcherScript.streamFn,
        },
        writer: {
          name: "writer",
          systemPrompt: "Write.",
          model: mockModel,
          streamFn: writerScript.streamFn,
        },
        reviewer: {
          name: "reviewer",
          systemPrompt: "Review.",
          model: mockModel,
          streamFn: reviewerScript.streamFn,
        },
      },
      tools: {},
    };
    const workflow = compilePiWorkflow(
      definePiWorkflow(
        { name: "pi-sequential-agents", schema: z.object({ topic: z.string() }) },
        async (ctx) => {
          const research = await ctx.agent("researcher").run("research", {
            mode: "prompt",
            input: { text: ctx.params.topic },
          });
          const draft = await ctx.agent("writer").prompt("draft", {
            input: { text: "write" },
            messages: research.messages,
          });
          const review = await ctx.agent("reviewer").continue("review", {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "review" }],
                timestamp: Date.now(),
              },
            ],
          });
          return {
            messageCount: research.messages.length + draft.messages.length + review.messages.length,
          };
        },
      ),
      { agents: config.agents, tools: config.tools },
    );

    await runScenario(
      defineScenario({
        name: "pi-sequential-agents",
        workflows: { custom: workflow },
        runners: ["worker"],
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({
            workflow: "custom",
            id: "custom-session",
            params: { topic: "fragno" },
          }),
          workflow.read({
            read: async (ctx) => {
              return {
                status: await ctx.state.getStatus("custom", "custom-session"),
                steps: await ctx.state.getSteps("custom", "custom-session"),
              };
            },
            assert: ({ status, steps }) => {
              expect(status).toMatchObject({ status: "complete", output: { messageCount: 5 } });
              expect(steps.map((step) => step.stepKey)).toEqual([
                "do:research",
                "do:draft",
                "do:review",
              ]);
            },
          }),
        ],
      }),
    );
  });
});

describe("definePiTool", () => {
  it("returns an AgentTool-compatible tool with Pi metadata", async () => {
    const parameters = Type.Object({ request: Type.String() });
    const resultSchema = z.object({ kind: z.enum(["bug", "feature"]), confidence: z.number() });

    const tool = definePiTool({
      name: "classify_request",
      label: "Classify request",
      description: "Classify an incoming request.",
      parameters,
      resultSchema,
      handoff: true,
      async execute(_toolCallId, params) {
        expectTypeOf(params).toMatchObjectType<Static<typeof parameters>>();
        return {
          content: [{ type: "text", text: `Classified ${params.request}.` }],
          details: { kind: "bug" as const, confidence: 0.91 },
          terminate: true,
        };
      },
    });

    expect(tool.name).toBe("classify_request");
    expect(tool.resultSchema).toBe(resultSchema);
    expect(tool.handoff).toBe(true);
    const agentTool: AgentTool<typeof parameters, { kind: "bug" | "feature"; confidence: number }> =
      tool;
    const piTool: PiTool = tool;
    expect(agentTool).toBe(tool);
    expect(piTool).toBe(tool);

    await expect(tool.execute("call-1", { request: "broken" })).resolves.toMatchObject({
      details: { kind: "bug", confidence: 0.91 },
      terminate: true,
    });
  });

  it("keeps typed Pi tools registerable through the existing builder path", () => {
    const lookup = definePiTool({
      name: "lookup",
      label: "Lookup",
      description: "Look up a query.",
      parameters: Type.Object({ query: Type.String() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: params.query }],
          details: { query: params.query },
        };
      },
    });

    const runtime = createPi()
      .withTool("lookup", lookup)
      .withAgent("default", {
        systemPrompt: "You are helpful.",
        model: mockModel,
        tools: ["lookup"],
      })
      .build();

    expect(runtime.config.tools.lookup).toBe(lookup);
    const registeredTool: PiToolDefinition<typeof lookup.parameters, { query: string }> = lookup;
    expect(registeredTool).toBe(lookup);
  });

  it("preserves details inference from execute results", async () => {
    const tool = definePiTool({
      name: "score",
      label: "Score",
      description: "Score a value.",
      parameters: Type.Object({ value: Type.Number() }),
      resultSchema: z.object({ score: z.number() }),
      async execute(_toolCallId, params) {
        return {
          content: [{ type: "text", text: String(params.value) }],
          details: { score: params.value },
        };
      },
    });

    const result = await tool.execute("call-1", { value: 5 });

    expectTypeOf(result.details).toMatchObjectType<{ score: number }>();
    expect(result.details.score).toBe(5);
  });
});
