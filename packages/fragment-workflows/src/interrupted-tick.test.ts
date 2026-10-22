import { assert, expect, test } from "vitest";

import { getRemoteWorkflowStepHost } from "./remote-workflow";
import { defineScenario, runScenario } from "./scenario";
import { defineRemoteWorkflow, defineWorkflow } from "./workflow";

/**
 * Each tick records its progress, then its host reports whether the executor could finish the
 * tick. The workflow swallows the report, which must not undo it.
 */
function defineFlakyWorkflow(interruptedTicks: number) {
  const progress = { ticks: 0, stepRuns: 0 };
  const workflow = defineRemoteWorkflow({ name: "flaky" }, async (_event, remote) => {
    await remote.do(null, "prepare", undefined, () => {
      progress.stepRuns += 1;
      return "prepared";
    });
    progress.ticks += 1;
    if (progress.ticks <= interruptedTicks) {
      try {
        remote.interruptTick("EXECUTOR_UNREACHABLE");
      } catch {
        return "swallowed";
      }
    }
    return "done";
  });
  return { progress, workflows: { FLAKY: workflow } };
}

test("an interrupted tick runs again after a growing delay and keeps its step progress", async () => {
  const { progress, workflows } = defineFlakyWorkflow(2);
  await runScenario(
    defineScenario({
      name: "two interrupted ticks, then the workflow completes",
      workflows,
      // Durable hooks fall due by database time, which follows the scenario clock only in memory.
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => {
        // The pending retry's delay, which is drawn from the upper half of its backoff.
        const scheduledRetryDelay = (range: { atLeast: number; atMost: number }) =>
          workflow.read({
            read: async (ctx) => {
              const hooks = await ctx.hooks.get({
                fragment: "workflows",
                hookName: "onWorkflowEnqueued",
              } as never);
              const pending = hooks.filter((hook) => hook.status === "pending");
              assert.equal(pending.length, 1);
              const [retry] = pending;
              assert(retry.nextRetryAt !== null);
              return retry.nextRetryAt.getTime() - retry.createdAt.getTime();
            },
            assert: (delayMs) => {
              assert.isAtLeast(delayMs, range.atLeast);
              assert.isAtMost(delayMs, range.atMost);
            },
          });
        return [
          workflow.create({ workflow: "FLAKY", id: "flaky-1", remoteWorkflowName: "flaky" }),
          runner.drainHooks(),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("FLAKY", "flaky-1"),
            assert: (status) => {
              assert.equal(status.status, "waiting");
              expect(progress).toEqual({ ticks: 1, stepRuns: 1 });
            },
          }),
          scheduledRetryDelay({ atLeast: 15_000, atMost: 30_000 }),
          runner.advanceTimeAndDrainHooks({ advanceBy: "30 seconds" }),
          workflow.assert(() => {
            assert.equal(progress.ticks, 2);
          }),
          // The second retry's backoff is twice the first's.
          scheduledRetryDelay({ atLeast: 30_000, atMost: 60_000 }),
          runner.advanceTimeAndDrainHooks({ advanceBy: "1 minute" }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("FLAKY", "flaky-1"),
            assert: (status) => {
              expect(status).toMatchObject({ status: "complete", output: "done" });
              expect(progress).toEqual({ ticks: 3, stepRuns: 1 });
            },
          }),
        ];
      },
    }),
  );
});

test("ticks interrupted together retry at different moments", async () => {
  const { workflows } = defineFlakyWorkflow(Number.POSITIVE_INFINITY);
  await runScenario(
    defineScenario({
      name: "one lost executor interrupts two instances",
      workflows,
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "FLAKY", id: "flaky-1", remoteWorkflowName: "flaky" }),
        workflow.create({ workflow: "FLAKY", id: "flaky-2", remoteWorkflowName: "flaky" }),
        runner.drainHooks(),
        workflow.read({
          read: async (ctx) => {
            const hooks = await ctx.hooks.get({
              fragment: "workflows",
              hookName: "onWorkflowEnqueued",
            } as never);
            return hooks
              .filter((hook) => hook.status === "pending")
              .map((hook) => {
                assert(hook.nextRetryAt !== null);
                return hook.nextRetryAt.getTime() - hook.createdAt.getTime();
              });
          },
          assert: (delays) => {
            assert.equal(delays.length, 2);
            assert.notEqual(delays[0], delays[1]);
            for (const delayMs of delays) {
              assert.isAtLeast(delayMs, 15_000);
              assert.isAtMost(delayMs, 30_000);
            }
          },
        }),
      ],
    }),
  );
});

test("the eighth consecutive interrupted tick errors the instance", async () => {
  const { progress, workflows } = defineFlakyWorkflow(Number.POSITIVE_INFINITY);
  await runScenario(
    defineScenario({
      name: "interrupted ticks exhaust their budget",
      workflows,
      // Durable hooks fall due by database time, which follows the scenario clock only in memory.
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "FLAKY", id: "flaky-1", remoteWorkflowName: "flaky" }),
        runner.drainHooks(),
        // Retries wait 30s, 1m, 2m, 4m, 8m, then 10m twice; each advance covers the longest.
        ...Array.from({ length: 6 }, () =>
          runner.advanceTimeAndDrainHooks({ advanceBy: "10 minutes" }),
        ),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("FLAKY", "flaky-1"),
          assert: (status) => {
            assert.equal(status.status, "waiting");
            assert.equal(progress.ticks, 7);
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "10 minutes" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("FLAKY", "flaky-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "errored",
              error: { name: "WorkflowTickInterrupted", message: "EXECUTOR_UNREACHABLE" },
            });
            expect(progress).toEqual({ ticks: 8, stepRuns: 1 });
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.assert(() => {
          assert.equal(progress.ticks, 8);
        }),
      ],
    }),
  );
});

test("a workflow that is not remote cannot interrupt its tick", async () => {
  let ticks = 0;
  const workflow = defineWorkflow({ name: "local" }, async (_event, step) => {
    ticks += 1;
    getRemoteWorkflowStepHost(step).interruptTick("EXECUTOR_UNREACHABLE");
  });
  await runScenario(
    defineScenario({
      name: "a local workflow's interruption errors it",
      workflows: { LOCAL: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "LOCAL", id: "local-1" }),
        runner.drainHooks(),
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 hour" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("LOCAL", "local-1"),
          assert: (status) => {
            expect(status).toMatchObject({
              status: "errored",
              error: { message: "EXECUTOR_UNREACHABLE" },
            });
            assert.equal(ticks, 1);
          },
        }),
      ],
    }),
  );
});

test("an interruption inside a step discards the attempt and stops further steps", async () => {
  const progress = { attempts: 0, afterRuns: 0 };
  const workflow = defineRemoteWorkflow({ name: "in-step" }, async (_event, remote) => {
    const value = await remote
      .do(null, "work", { retries: { limit: 1, delay: "1 second" } }, () => {
        progress.attempts += 1;
        if (progress.attempts === 1) {
          remote.interruptTick("EXECUTOR_UNREACHABLE");
        }
        if (progress.attempts === 2) {
          throw new Error("flaky");
        }
        return "worked";
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "WorkflowTickInterrupted") {
          return "swallowed";
        }
        throw error;
      });
    await remote.do(null, "after", undefined, () => {
      progress.afterRuns += 1;
      return null;
    });
    return value;
  });
  await runScenario(
    defineScenario({
      name: "an interrupted step attempt leaves no trace",
      workflows: { IN_STEP: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "IN_STEP", id: "in-step-1", remoteWorkflowName: "in-step" }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("IN_STEP", "in-step-1"),
          assert: (status) => {
            assert.equal(status.status, "waiting");
            expect(progress).toEqual({ attempts: 1, afterRuns: 0 });
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "30 seconds" }),
        // The ordinary failure still has the step's one retry, so the interrupted attempt was free.
        runner.advanceTimeAndDrainHooks({ advanceBy: "1 second" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("IN_STEP", "in-step-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "worked" });
            expect(progress).toEqual({ attempts: 3, afterRuns: 1 });
          },
        }),
      ],
    }),
  );
});

test("an interruption while consuming an event leaves the event for the rerun", async () => {
  let consumptions = 0;
  const workflow = defineRemoteWorkflow({ name: "approval" }, async (_event, remote) => {
    const approval = await remote.waitForEvent<{ by: string }>(null, "approval", {
      type: "approved",
      onConsume: () => {
        consumptions += 1;
        if (consumptions === 1) {
          remote.interruptTick("EXECUTOR_UNREACHABLE");
        }
      },
    });
    return approval.payload.by;
  });
  await runScenario(
    defineScenario({
      name: "an interrupted event consumption is retried",
      workflows: { APPROVAL: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "APPROVAL", id: "approval-1", remoteWorkflowName: "approval" }),
        runner.drainHooks(),
        workflow.event({
          workflow: "APPROVAL",
          instanceId: "approval-1",
          event: { type: "approved", payload: { by: "ada" } },
        }),
        runner.drainHooks(),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("APPROVAL", "approval-1"),
          assert: (status) => {
            assert.equal(status.status, "waiting");
            assert.equal(consumptions, 1);
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "30 seconds" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("APPROVAL", "approval-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "ada" });
            assert.equal(consumptions, 2);
          },
        }),
      ],
    }),
  );
});

test("a healthy tick resets the interruption count that a stale retry would carry", async () => {
  const executor = { down: true, ticks: 0 };
  const workflow = defineRemoteWorkflow({ name: "recovering" }, async (_event, remote) => {
    executor.ticks += 1;
    if (executor.down) {
      remote.interruptTick("EXECUTOR_UNREACHABLE");
    }
    await remote.waitForEvent(null, "ready", { type: "ready" });
    return await remote.waitForEvent(null, "done", { type: "done" });
  });
  await runScenario(
    defineScenario({
      name: "interruptions separated by a healthy tick are not consecutive",
      workflows: { RECOVERING: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({
          workflow: "RECOVERING",
          id: "recovering-1",
          remoteWorkflowName: "recovering",
        }),
        runner.drainHooks(),
        // Six retries after the first interruption leave the seventh's retry scheduled.
        ...Array.from({ length: 6 }, () =>
          runner.advanceTimeAndDrainHooks({ advanceBy: "10 minutes" }),
        ),
        workflow.assert(() => {
          assert.equal(executor.ticks, 7);
          executor.down = false;
        }),
        workflow.event({
          workflow: "RECOVERING",
          instanceId: "recovering-1",
          event: { type: "ready", payload: {} },
        }),
        runner.drainHooks(),
        workflow.assert(() => {
          assert.equal(executor.ticks, 8);
          executor.down = true;
        }),
        // The seventh interruption's retry still fires, but the healthy tick broke the run.
        runner.advanceTimeAndDrainHooks({ advanceBy: "10 minutes" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("RECOVERING", "recovering-1"),
          assert: (status) => {
            assert.equal(executor.ticks, 9);
            assert.equal(status.status, "waiting");
          },
        }),
      ],
    }),
  );
});

test("an interrupted attempt's emissions are cleaned up like a failed attempt's", async () => {
  const attempts: { previousEmissions: unknown[] }[] = [];
  const workflow = defineRemoteWorkflow({ name: "emitter" }, async (_event, remote) => {
    return await remote.do(null, "work", undefined, async (tx) => {
      attempts.push({ previousEmissions: await tx.previousEmissions() });
      tx.emit({ attempt: attempts.length });
      if (attempts.length === 1) {
        remote.interruptTick("EXECUTOR_UNREACHABLE");
      }
      return "done";
    });
  });
  await runScenario(
    defineScenario({
      name: "an interrupted attempt leaves no emissions behind",
      workflows: { EMITTER: workflow },
      harness: { adapter: { type: "in-memory" }, autoTickHooks: true },
      steps: ({ workflow, runner }) => [
        workflow.create({ workflow: "EMITTER", id: "emitter-1", remoteWorkflowName: "emitter" }),
        runner.drainHooks(),
        // Live readers saw the attempt's emission while it ran; its epoch is cleaned up after.
        workflow.read({
          read: async (ctx) => ({
            emissions: await ctx.state.getEmissions("EMITTER", "emitter-1"),
            cleanups: (
              await ctx.hooks.get({
                fragment: "workflows",
                hookName: "onWorkflowStepEmissionsCleanup",
              } as never)
            ).map((hook: { status: string }) => hook.status),
          }),
          assert: ({ emissions, cleanups }) => {
            expect(emissions).toEqual([]);
            expect(cleanups).toEqual(["completed"]);
          },
        }),
        runner.advanceTimeAndDrainHooks({ advanceBy: "30 seconds" }),
        workflow.read({
          read: (ctx) => ctx.state.getStatus("EMITTER", "emitter-1"),
          assert: (status) => {
            expect(status).toMatchObject({ status: "complete", output: "done" });
            // The rerun starts the step afresh, without the interrupted attempt's emissions.
            expect(attempts).toEqual([{ previousEmissions: [] }, { previousEmissions: [] }]);
          },
        }),
      ],
    }),
  );
});
