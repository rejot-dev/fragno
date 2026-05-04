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

  it("stops a running agent after the third date && sleep 1", async () => {
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
        s.releaseAll(),
        s.awaitBackground("promptRun"),
        s.assert(async (ctx) => {
          cleanup = ctx.cleanup;

          expect(ctx.agent.checkpoints().map((checkpoint) => checkpoint.name)).toEqual([
            "date && sleep 1 #1",
            "date && sleep 1 #2",
            "date && sleep 1 #3",
          ]);
          expect(ctx.agent.injections()).toEqual([expect.objectContaining({ kind: "abort" })]);

          const detail = await ctx.assertStopped(ctx.vars.sessionId!);
          expect(detail.turn).toBe(1);
          expect(detail.turns[0]).toMatchObject({ status: "aborted" });
          expect(detail.turns[0]?.operations[0]).toMatchObject({
            kind: "prompt",
            outcome: "aborted",
          });
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
          expect(detail.turn).toBe(2);
          expect(detail.turns.map((turn) => turn.status)).toEqual(["aborted", "completed"]);
          expect(detail.turns[1]?.operations[0]).toMatchObject({
            kind: "prompt",
            outcome: "completed",
          });
        }),
      ],
    });

    const ctx = await runPiScenario(scenario);
    cleanup = ctx.cleanup;
  });
});
