import { afterEach, describe, expect, it } from "vitest";

import { definePiScenario, piSteps, runPiScenario } from "./scenario";

type Vars = {
  sessionId: string;
  promptRun: unknown;
  abortResponse: unknown;
  afterStopRun: unknown;
};

const s = piSteps<Vars>();

describe("Pi scenarios", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("sends abort commands from the command route to the active workflow step", async () => {
    const scenario = definePiScenario<Vars>({
      name: "stop repeated date command after third run",
      checkpoints: [
        "date && sleep 1 #1",
        "date && sleep 1 #2",
        "date && sleep 1 #3",
        "date && sleep 1 #4",
        "date && sleep 1 #5",
        "date && sleep 1 #6",
        "date && sleep 1 #7",
        "date && sleep 1 #8",
        "date && sleep 1 #9",
        "date && sleep 1 #10",
      ],
      steps: [
        s.createSession({ storeAs: "sessionId" }),
        s.prompt({
          sessionId: (ctx) => ctx.vars.sessionId!,
          text: "run `date && sleep 1` 10 times",
        }),
        s.runAgentInBackground({
          sessionId: (ctx) => ctx.vars.sessionId!,
          storeAs: "promptRun",
        }),
        s.waitForCheckpoint("date && sleep 1 #1"),
        s.releaseCheckpoint("date && sleep 1 #1"),
        s.waitForCheckpoint("date && sleep 1 #2"),
        s.releaseCheckpoint("date && sleep 1 #2"),
        s.waitForCheckpoint("date && sleep 1 #3"),
        s.abort({
          sessionId: (ctx) => ctx.vars.sessionId!,
          reason: "stop after third date && sleep 1",
          storeAs: "abortResponse",
        }),
        s.waitForInjection("abort"),
        s.releaseAll(),
        s.awaitBackground("promptRun"),
        s.assert(async (ctx) => {
          cleanup = ctx.cleanup;

          expect(ctx.agent.checkpoints().map((checkpoint) => checkpoint.name)).toEqual([
            "date && sleep 1 #1",
            "date && sleep 1 #2",
            "date && sleep 1 #3",
          ]);
          expect(ctx.agent.injections()).toMatchObject([{ kind: "abort" }]);

          await ctx.assertStopped(ctx.vars.sessionId!);
        }),
        s.prompt({
          sessionId: (ctx) => ctx.vars.sessionId!,
          text: "run one more command after stop",
        }),
        s.runAgentInBackground({
          sessionId: (ctx) => ctx.vars.sessionId!,
          storeAs: "afterStopRun",
        }),
        s.awaitBackground("afterStopRun"),
        s.assert(async (ctx) => {
          const detail = await ctx.assertStopped(ctx.vars.sessionId!);
          expect(detail.agent.state.messages.length).toBeGreaterThan(0);
        }),
      ],
    });

    const ctx = await runPiScenario(scenario);
    cleanup = ctx.cleanup;
  });

  it("does not replay an abort command into the next agent run", async () => {
    const scenario = definePiScenario<Vars>({
      name: "abort command is consumed once",
      checkpoints: ["first run", "second run"],
      steps: [
        s.createSession({ storeAs: "sessionId" }),
        s.prompt({
          sessionId: (ctx) => ctx.vars.sessionId!,
          text: "start first task",
        }),
        s.runAgentInBackground({
          sessionId: (ctx) => ctx.vars.sessionId!,
          storeAs: "promptRun",
        }),
        s.waitForCheckpoint("first run"),
        s.abort({
          sessionId: (ctx) => ctx.vars.sessionId!,
          reason: "stop first task",
          storeAs: "abortResponse",
        }),
        s.waitForInjection("abort"),
        s.releaseAll(),
        s.awaitBackground("promptRun"),
        s.assert(async (ctx) => {
          await ctx.assertStopped(ctx.vars.sessionId!);
          expect(ctx.agent.injections()).toMatchObject([{ kind: "abort" }]);
        }),
        s.prompt({
          sessionId: (ctx) => ctx.vars.sessionId!,
          text: "start second task",
        }),
        s.runAgentInBackground({
          sessionId: (ctx) => ctx.vars.sessionId!,
          storeAs: "afterStopRun",
        }),
        s.waitForCheckpoint("second run"),
        s.releaseAll(),
        s.awaitBackground("afterStopRun"),
        s.assert(async (ctx) => {
          expect(ctx.agent.injections()).toMatchObject([{ kind: "abort" }]);
        }),
      ],
    });

    const ctx = await runPiScenario(scenario);
    cleanup = ctx.cleanup;
  });

  it("sends steer commands from the command route to the active workflow step", async () => {
    const scenario = definePiScenario<Vars>({
      name: "steer running agent",
      checkpoints: ["before steer", "after steer"],
      steps: [
        s.createSession({ storeAs: "sessionId" }),
        s.prompt({
          sessionId: (ctx) => ctx.vars.sessionId!,
          text: "start long task",
        }),
        s.runAgentInBackground({
          sessionId: (ctx) => ctx.vars.sessionId!,
          storeAs: "promptRun",
        }),
        s.waitForCheckpoint("before steer"),
        s.steer({
          sessionId: (ctx) => ctx.vars.sessionId!,
          text: "adjust course",
        }),
        s.waitForInjection("steer"),
        s.releaseAll(),
        s.awaitBackground("promptRun"),
        s.assert(async (ctx) => {
          cleanup = ctx.cleanup;
          expect(ctx.agent.injections()).toMatchObject([
            { kind: "steer", input: { text: "adjust course" } },
          ]);
          await ctx.assertStopped(ctx.vars.sessionId!);
        }),
      ],
    });

    const ctx = await runPiScenario(scenario);
    cleanup = ctx.cleanup;
  });
});
