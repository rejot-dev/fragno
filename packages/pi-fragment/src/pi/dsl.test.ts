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
  renderPiSkillCatalogXml,
  type PiAgentDefinitionInput,
  type PiRuntime,
  type PiSkillDefinition,
  type PiTool,
  type PiToolDefinition,
  type PiWorkflowDefinition,
} from "./dsl";
import { createPiWorkflows, type PiAgentRunner } from "./factory";
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

  it("preserves literal skill names and requires agents to reference registered skills", () => {
    createPi()
      .withSkill("fragno", { description: "Use when working on Fragno fragments." })
      .withAgent("author", {
        systemPrompt: "You author fragments.",
        model: mockModel,
        skills: ["fragno"],
      });

    createPi()
      .withSkill("fragno", { description: "Use when working on Fragno fragments." })
      .withAgent("author", {
        systemPrompt: "You author fragments.",
        model: mockModel,
        // @ts-expect-error - missing is not in the registered skill names.
        skills: ["missing"],
      });

    createPi().withAgent("author", {
      systemPrompt: "You author fragments.",
      model: mockModel,
      // @ts-expect-error - fragno must be registered before an agent can reference it.
      skills: ["fragno"],
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

  it("registers manually defined skills", () => {
    const directSkill = {
      name: "fragno",
      description: "Use when working on Fragno fragments.",
      body: "Follow Fragno conventions.",
      location: "/repo/.agents/skills/fragno/SKILL.md",
      resources: [
        {
          path: "references/fragment-authoring.md",
          description: "Fragment authoring reference.",
          content: "Reference content.",
          mimeType: "text/markdown",
          metadata: { kind: "reference" },
        },
      ],
      metadata: { source: "manual" },
    } satisfies PiSkillDefinition;

    const runtime = createPi().withSkill("fragno", directSkill).build();

    expectTypeOf(runtime.config.skills["fragno"].name).toEqualTypeOf<"fragno">();
    expect(runtime.config.skills["fragno"]).toEqual(directSkill);
  });

  it("builds manual skills with the withSkill builder callback", () => {
    const runtime = createPi()
      .withSkill("fragno", (skill) =>
        skill
          .description("Use when working on Fragno fragments.")
          .body("Follow Fragno conventions.")
          .location("/repo/.agents/skills/fragno/SKILL.md")
          .resource("references/fragment-authoring.md", {
            description: "Fragment authoring reference.",
            content: "Reference content.",
            mimeType: "text/markdown",
            metadata: { kind: "reference" },
          })
          .metadata({ source: "manual" })
          .metadataValue("enabled", true),
      )
      .build();

    expect(runtime.config.skills["fragno"]).toEqual({
      name: "fragno",
      description: "Use when working on Fragno fragments.",
      body: "Follow Fragno conventions.",
      location: "/repo/.agents/skills/fragno/SKILL.md",
      resources: [
        {
          path: "references/fragment-authoring.md",
          description: "Fragment authoring reference.",
          content: "Reference content.",
          mimeType: "text/markdown",
          metadata: { kind: "reference" },
        },
      ],
      metadata: { source: "manual", enabled: true },
    });
  });

  it("rejects skills without descriptions", () => {
    expect(() => createPi().withSkill("fragno", {} as PiSkillDefinition)).toThrow(
      "Skill 'fragno' must define a description.",
    );
    expect(() => createPi().withSkill("fragno", (skill) => skill)).toThrow(
      "Skill 'fragno' must define a description.",
    );
  });

  it("renders a deterministic XML skill catalog", () => {
    const runtime = createPi()
      .withSkill("z-review", { description: 'Review <code> & explain "risks".' })
      .withSkill("a-author", { description: "Author Fragno fragments." })
      .build();

    expect(renderPiSkillCatalogXml(runtime.config.skills)).toBe(`<available_skills>
  <skill>
    <name>a-author</name>
    <description>Author Fragno fragments.</description>
  </skill>
  <skill>
    <name>z-review</name>
    <description>Review &lt;code&gt; &amp; explain &quot;risks&quot;.</description>
  </skill>
</available_skills>`);
  });

  it("renders an empty string when there are no skills", () => {
    expect(renderPiSkillCatalogXml({})).toBe("");
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

  it("adds skill invocation context to agent runs", async () => {
    const observedRuns: Array<{ mode: string; messages: readonly unknown[] }> = [];
    const agentRunner: PiAgentRunner = async (operation, runtime) => {
      observedRuns.push({ mode: operation.mode, messages: runtime.turn.messages });
      return {
        stopReason: "stop",
        messages: runtime.turn.messages,
        events: [],
        errorMessage: null,
      };
    };
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "Base prompt.",
          model: mockModel,
          skills: ["fragno"],
        },
      },
      tools: {},
      skills: {
        fragno: {
          name: "fragno",
          description: "Use when working on Fragno fragments.",
          body: "Follow Fragno conventions.",
          location: "/repo/.agents/skills/fragno/SKILL.md",
          resources: [{ path: "references/authoring.md" }],
        },
      },
    };
    const workflow = compilePiWorkflow(
      definePiWorkflow({ name: "pi-skill-invocation-context" }, async (ctx) => {
        await ctx.agentStep("default").skill("invoke-fragno", {
          skill: "fragno",
          extraInstructions: "Focus on the Pi DSL.",
        });
        await ctx.agentStep("default").run("run-with-skill", {
          mode: "continue",
          skill: "fragno",
          extraInstructions: "Explain tradeoffs.",
        });
        return { ok: true };
      }),
      {
        agents: config.agents,
        tools: config.tools,
        skills: config.skills,
        agentRunner,
      },
    );

    await runScenario(
      defineScenario({
        name: "pi-skill-invocation-context",
        workflows: { custom: workflow },
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker"],
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({ workflow: "custom", id: "session-1" }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("custom", "session-1"),
            assert: (status) => {
              expect(status.status).toBe("complete");
              expect(observedRuns.map((run) => run.mode)).toEqual(["continue", "continue"]);
              const [firstRun, secondRun] = observedRuns;
              assert(firstRun);
              assert(secondRun);
              expect(firstRun.messages).toHaveLength(1);
              expect(secondRun.messages).toHaveLength(1);
              const firstMessage = firstRun.messages[0] as {
                role: string;
                content: Array<{ type: string; text: string }>;
              };
              const secondMessage = secondRun.messages[0] as {
                role: string;
                content: Array<{ type: string; text: string }>;
              };
              expect(firstMessage.role).toBe("user");
              expect(firstMessage.content[0]?.text).toContain('<skill_content name="fragno">');
              expect(firstMessage.content[0]?.text).toContain("Follow Fragno conventions.");
              expect(firstMessage.content[0]?.text).toContain(
                "<directory>/repo/.agents/skills/fragno</directory>",
              );
              expect(firstMessage.content[0]?.text).toContain(
                "<resource_path_note>Resource file paths are relative to the skill itself.</resource_path_note>",
              );
              expect(firstMessage.content[0]?.text).toContain(
                "<path>references/authoring.md</path>",
              );
              expect(firstMessage.content[0]?.text).toContain("\n\nFocus on the Pi DSL.");
              expect(secondMessage.content[0]?.text).toContain("\n\nExplain tradeoffs.");
            },
          }),
        ],
      }),
    );
  });

  it("runs skill invocations in prompt mode when input is provided", async () => {
    const observedRuns: Array<{
      mode: string;
      promptInput?: unknown;
      messages: readonly unknown[];
    }> = [];
    const agentRunner: PiAgentRunner = async (operation, runtime) => {
      observedRuns.push({
        mode: operation.mode,
        promptInput: operation.promptInput,
        messages: runtime.turn.messages,
      });
      return {
        stopReason: "stop",
        messages: runtime.turn.messages,
        events: [],
        errorMessage: null,
      };
    };
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "Base prompt.",
          model: mockModel,
          skills: ["pdf-processing"],
        },
      },
      tools: {},
      skills: {
        "pdf-processing": {
          name: "pdf-processing",
          description: "Use when working with PDF files.",
          body: "Prefer robust PDF extraction.",
          directory: "/home/user/.agents/skills/pdf-processing",
          resources: [{ path: "scripts/extract.py" }],
        },
      },
    };
    const workflow = compilePiWorkflow(
      definePiWorkflow({ name: "pi-skill-prompt-mode" }, async (ctx) => {
        await ctx.agentStep("default").skill("pdf-task", {
          skill: "pdf-processing",
          input: { text: "Extract the report title." },
          extraInstructions: "Use OCR if embedded text is missing.",
        });
        return { ok: true };
      }),
      {
        agents: config.agents,
        tools: config.tools,
        skills: config.skills,
        agentRunner,
      },
    );

    await runScenario(
      defineScenario({
        name: "pi-skill-prompt-mode",
        workflows: { custom: workflow },
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker"],
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({ workflow: "custom", id: "session-1" }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("custom", "session-1"),
            assert: (status) => {
              expect(status.status).toBe("complete");
              expect(observedRuns).toHaveLength(1);
              const run = observedRuns[0];
              assert(run);
              expect(run.mode).toBe("prompt");
              expect(run.promptInput).toEqual({ text: "Extract the report title." });
              expect(run.messages).toHaveLength(1);
              const skillMessage = run.messages[0] as {
                role: string;
                content: Array<{ type: string; text: string }>;
              };
              expect(skillMessage.role).toBe("user");
              expect(skillMessage.content[0]?.text).toContain(
                '<skill_content name="pdf-processing">',
              );
              expect(skillMessage.content[0]?.text).toContain(
                "<directory>/home/user/.agents/skills/pdf-processing</directory>",
              );
              expect(skillMessage.content[0]?.text).toContain(
                "<resource_path_note>Resource file paths are relative to the skill itself.</resource_path_note>",
              );
              expect(skillMessage.content[0]?.text).toContain(
                "\n\nUse OCR if embedded text is missing.",
              );
            },
          }),
        ],
      }),
    );
  });

  it("appends the selected skill catalog to the agent system prompt", async () => {
    let observedSystemPrompt: string | undefined;
    const agentRunner: PiAgentRunner = async (_operation, runtime) => {
      observedSystemPrompt = runtime.session.systemPrompt;
      return {
        stopReason: "stop",
        messages: runtime.turn.messages,
        events: [],
        errorMessage: null,
      };
    };
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "Base prompt.",
          model: mockModel,
          skills: ["fragno"],
        },
      },
      tools: {},
      skills: {
        fragno: { name: "fragno", description: "Use when working on Fragno fragments." },
        unused: { name: "unused", description: "Should not be shown." },
      },
    };
    const workflow = compilePiWorkflow(
      definePiWorkflow({ name: "pi-skill-system-prompt" }, async (ctx) => {
        await ctx.agentStep("default").prompt("ask", { input: { text: "hello" } });
        return { ok: true };
      }),
      {
        agents: config.agents,
        tools: config.tools,
        skills: config.skills,
        agentRunner,
      },
    );

    await runScenario(
      defineScenario({
        name: "pi-skill-system-prompt",
        workflows: { custom: workflow },
        harness: {
          configureFragments: (harness) => ({
            pi: instantiate(piFragmentDefinition)
              .withConfig(config)
              .withServices({ workflows: harness.fragment.services }),
          }),
        },
        runners: ["worker"],
        steps: ({ runners, workflow }) => [
          runners.worker.initializeAndRunUntilIdle({ workflow: "custom", id: "session-1" }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("custom", "session-1"),
            assert: (status) => {
              expect(status.status).toBe("complete");
              expect(observedSystemPrompt).toBe(`Base prompt.

The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, use that skill before proceeding.
<available_skills>
  <skill>
    <name>fragno</name>
    <description>Use when working on Fragno fragments.</description>
  </skill>
</available_skills>`);
            },
          }),
        ],
      }),
    );
  });

  it("compiles context primitives to workflow steps", async () => {
    const workflow = compilePiWorkflow(
      definePiWorkflow(
        { name: "pi-context-primitives", schema: z.object({ sessionId: z.string() }) },
        async (ctx) => {
          await ctx.do("emit-ready", (tx) => tx.emit({ type: "ready" }));
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
      expectTypeOf(ctx.agentStep("agent").run).parameters.toExtend<
        [string, { mode: "prompt" | "continue" }]
      >();
      expectTypeOf(ctx.agentStep("agent").prompt).parameters.toExtend<
        [string, { input: { text: string } }]
      >();
      expectTypeOf(ctx.agentStep("agent").continue).parameters.toExtend<
        [string, { messages?: unknown[] }?]
      >();
      expectTypeOf(ctx.agentStep("agent").skill).toBeFunction();
      expectTypeOf(ctx).not.toHaveProperty("agent");
      expectTypeOf(ctx.do).toEqualTypeOf(ctx.step.do);
      expectTypeOf(ctx.waitForEvent).toBeFunction();
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
          const [security, clarity] = await ctx.do("parallel-reviews", () =>
            Promise.all([
              ctx.agentStep("security").prompt("security-review", {
                input: { text: `Security review: ${ctx.params.draft}` },
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: "security context" }],
                    timestamp: Date.now(),
                  },
                ],
              }),
              ctx.agentStep("clarity").prompt("clarity-review", {
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
        const result = await ctx.do("approval-race", () =>
          Promise.race([
            ctx
              .waitForEvent("approval", {
                allowed: ["complete", "abort"],
              })
              .then((command) => ({ kind: command.kind })),
            ctx.do("timeout-branch", async () => {
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
        const first = await ctx.do("first-success", () =>
          Promise.any([
            ctx.do("slow-branch", async () => {
              await ctx.sleep("ready-delay", "1 hour");
              return { kind: "slept" as const };
            }),
            ctx.do("fast-branch", async () => ({ kind: "fast" as const })),
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
          const research = await ctx.agentStep("researcher").run("research", {
            mode: "prompt",
            input: { text: ctx.params.topic },
          });
          const draft = await ctx.agentStep("writer").prompt("draft", {
            input: { text: "write" },
            messages: research.messages,
          });
          const review = await ctx.agentStep("reviewer").continue("review", {
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
