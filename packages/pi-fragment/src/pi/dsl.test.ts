import { describe, expect, expectTypeOf, it } from "vitest";

import { createPi, type PiAgentDefinitionInput, type PiRuntime } from "./dsl";
import { mockModel } from "./pi-test-utils";
import type { PiToolFactory } from "./types";

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
    }) satisfies PiToolFactory;
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
    }) satisfies PiToolFactory;

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
    }) satisfies PiToolFactory;

    const runtime = createPi().withTool("search", tool).withAgent("default", agent).build();

    expect(runtime.config.agents).toEqual({ default: { ...agent, name: "default" } });
    expect(runtime.config.tools).toEqual({ search: tool });
    expect(runtime.workflows).toHaveProperty("agentLoop");
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
    }) satisfies PiToolFactory;
    const secondTool = (async () => {
      throw new Error("second test tool should not execute");
    }) satisfies PiToolFactory;

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
    }) satisfies PiToolFactory;
    const changedTool = (async () => {
      throw new Error("changed test tool should not execute");
    }) satisfies PiToolFactory;

    const runtime = builder
      .withAgent("default", originalAgent)
      .withTool("lookup", originalTool)
      .build();
    builder.withAgent("default", changedAgent).withTool("lookup", changedTool);

    expect(runtime.config.agents["default"]?.systemPrompt).toBe("You are helpful.");
    expect(runtime.config.tools["lookup"]).toBe(originalTool);
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
