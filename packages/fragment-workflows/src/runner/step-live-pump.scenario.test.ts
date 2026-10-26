import { assert, expect, test, vi } from "vitest";

import { defineScenario, runScenario } from "../scenario";
import { defineWorkflow } from "../workflow";
import { workflowStepLivePumpKey, type WorkflowStepLivePump } from "./step-live-pump";

async function advancePump(pump: WorkflowStepLivePump, milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await pump.drain();
  // Fake timers defer zero-delay timers created inside a timer callback by one millisecond.
  // Let a consumption-marker refresh run even after its last listener unsubscribes.
  await vi.advanceTimersByTimeAsync(1);
  await pump.drain();
}

test("an idle SQLite step wakes for batched emissions and events, then drains its final output", async () => {
  const entered = Promise.withResolvers<void>();
  const emitProgress = Promise.withResolvers<void>();
  const progressQueued = Promise.withResolvers<void>();
  const listen = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<void>();
  const approved = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queries: string[] = [];
  const workflow = defineWorkflow({ name: "demand-driven-step" }, async (_event, step) => {
    return await step.do("publish", async (tx) => {
      entered.resolve();
      await emitProgress.promise;
      tx.emit({ phase: "prepared" });
      tx.emit({ phase: "uploaded" });
      progressQueued.resolve();
      await listen.promise;
      const unsubscribe = tx.onEvent("approve", (event) => {
        event.consume();
        unsubscribe();
        approved.resolve();
      });
      listening.resolve();
      await approved.promise;
      await release.promise;
      tx.emit({ phase: "published" });
      return { published: true };
    });
  });

  try {
    await runScenario(
      defineScenario({
        name: "idle-step-progress-and-events",
        workflows: { publish: workflow },
        harness: {
          adapter: { type: "kysely-sqlite", uowConfig: { onQuery: (q) => queries.push(q.sql) } },
          autoTickHooks: false,
        },
        steps: ({ workflow, runner }) => [
          workflow.create({ workflow: "publish", id: "release" }),
          workflow.read({
            read: async (ctx) => {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              const tick = ctx.harness.tick({
                workflowName: "demand-driven-step",
                instanceId: "release",
                reason: "create",
              });
              try {
                await entered.promise;
                const pump = ctx.harness.deps.stepEmissions.get(
                  workflowStepLivePumpKey("demand-driven-step", "release"),
                );
                assert(pump);
                await advancePump(pump, 100);
                const scope = pump.getScopeMeta("do:publish");
                assert(scope);
                assert(scope.flushCount === 1);
                expect(await ctx.state.getEmissions("publish", "release")).toMatchObject([
                  { actor: "system", payload: { control: "step-started" } },
                ]);

                queries.length = 0;
                await advancePump(pump, 54_600);
                expect(queries).toEqual([]);
                assert(scope.flushCount === 1);
                assert(vi.getTimerCount() === 0);

                emitProgress.resolve();
                await progressQueued.promise;
                await advancePump(pump, 100);
                expect(scope).toMatchObject({ applicationEmissionsFlushed: 2 });
                expect(
                  await ctx.state.getEmissions("publish", "release", { actor: "user" }),
                ).toMatchObject([
                  { payload: { phase: "prepared" } },
                  { payload: { phase: "uploaded" } },
                ]);

                listen.resolve();
                await listening.promise;
                await ctx.harness.sendEvent("publish", "release", { type: "approve" });
                await advancePump(pump, 100);
                await approved.promise;
                expect(await ctx.state.getEmissions("publish", "release")).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      payload: expect.objectContaining({ control: "event-consumed" }),
                    }),
                  ]),
                );
                expect(scope.eventPollCount).toBeGreaterThan(0);
                const polls = scope.eventPollCount;
                queries.length = 0;
                await advancePump(pump, 54_600);
                expect(queries).toEqual([]);
                expect(scope.eventPollCount).toBe(polls);
                assert(vi.getTimerCount() === 0);

                release.resolve();
                await tick;
                expect(scope).toMatchObject({ applicationEmissionsFlushed: 3 });
                assert(pump.scopeCount() === 0);
                assert(pump.activeSchedulerLeaseCount() === 0);
              } finally {
                emitProgress.resolve();
                listen.resolve();
                approved.resolve();
                release.resolve();
                await tick;
                vi.useRealTimers();
              }
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("publish", "release"),
            assert: (status) =>
              expect(status).toMatchObject({ status: "complete", output: { published: true } }),
          }),
          workflow.read({
            read: (ctx) => ctx.state.getEvents("publish", "release"),
            assert: (events) => expect(events).toMatchObject([{ consumedByStepKey: "do:publish" }]),
          }),
          workflow.read({
            read: (ctx) => ctx.state.getEmissions("publish", "release", { actor: "user" }),
            assert: (emissions) =>
              expect(emissions).toMatchObject([
                { payload: { phase: "prepared" } },
                { payload: { phase: "uploaded" } },
                { payload: { phase: "published" } },
              ]),
          }),
          runner.restart(),
          runner.tick({ workflow: "publish", instanceId: "release", reason: "retry" }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("publish", "release"),
            assert: (steps) => expect(steps).toMatchObject([{ status: "completed", attempts: 1 }]),
          }),
        ],
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("a shared pump keeps a sibling listener alive and sleeps once that sibling finishes", async () => {
  const idleEntered = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<void>();
  const listenerFinished = Promise.withResolvers<void>();
  const approved = Promise.withResolvers<void>();
  const releaseIdle = Promise.withResolvers<void>();
  const queries: string[] = [];
  const workflow = defineWorkflow({ name: "parallel-pump-demand" }, async (_event, step) => {
    return await Promise.all([
      step.do("external-call", async () => {
        idleEntered.resolve();
        await releaseIdle.promise;
        return "published";
      }),
      step
        .do("approval", async (tx) => {
          const unsubscribe = tx.onEvent("approve", (event) => {
            event.consume();
            unsubscribe();
            approved.resolve();
          });
          listening.resolve();
          await approved.promise;
          return "approved";
        })
        .then((result) => {
          listenerFinished.resolve();
          return result;
        }),
    ]);
  });
  try {
    await runScenario(
      defineScenario({
        name: "parallel-step-demand",
        workflows: { parallel: workflow },
        harness: {
          adapter: { type: "kysely-sqlite", uowConfig: { onQuery: (q) => queries.push(q.sql) } },
          autoTickHooks: false,
        },
        steps: ({ workflow }) => [
          workflow.create({ workflow: "parallel", id: "release" }),
          workflow.read({
            read: async (ctx) => {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              const tick = ctx.harness.tick({
                workflowName: "parallel-pump-demand",
                instanceId: "release",
                reason: "create",
              });
              try {
                await Promise.all([idleEntered.promise, listening.promise]);
                const pump = ctx.harness.deps.stepEmissions.get(
                  workflowStepLivePumpKey("parallel-pump-demand", "release"),
                );
                assert(pump);
                await advancePump(pump, 100);
                assert(pump.scopeCount() === 2);
                await ctx.harness.sendEvent("parallel", "release", { type: "approve" });
                await advancePump(pump, 100);
                await listenerFinished.promise;
                assert(pump.scopeCount() === 1);
                queries.length = 0;
                await advancePump(pump, 54_600);
                expect(queries).toEqual([]);
                assert(vi.getTimerCount() === 0);
              } finally {
                approved.resolve();
                releaseIdle.resolve();
                await tick;
                vi.useRealTimers();
              }
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("parallel", "release"),
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: ["published", "approved"],
              });
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getSteps("parallel", "release"),
            assert: (steps) => {
              expect(steps).toHaveLength(2);
              assert(steps.every((step) => step.status === "completed"));
            },
          }),
        ],
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("a failed consumed-event attempt drains output and replays the event after a runner restart", async () => {
  const firstEntered = Promise.withResolvers<void>();
  const retryEntered = Promise.withResolvers<void>();
  const firstRelease = Promise.withResolvers<void>();
  const retryRelease = Promise.withResolvers<void>();
  let attempts = 0;
  const observed: unknown[] = [];
  const workflow = defineWorkflow({ name: "retry-event-consumption" }, async (_event, step) => {
    return await step.do(
      "approve",
      { retries: { limit: 1, delay: 0, backoff: "constant" } },
      async (tx) => {
        const attempt = ++attempts;
        const approved = Promise.withResolvers<void>();
        const unsubscribe = tx.onEvent("approve", (event) => {
          event.consume();
          unsubscribe();
          approved.resolve();
        });
        (attempt === 1 ? firstEntered : retryEntered).resolve();
        await Promise.race([
          approved.promise,
          (attempt === 1 ? firstRelease : retryRelease).promise,
        ]);
        tx.emit({ attempt });
        if (attempt === 1) {
          throw new Error("RETRY_PUBLICATION");
        }
        return "published";
      },
    );
  });
  try {
    await runScenario(
      defineScenario({
        name: "retry-consumed-event",
        workflows: { publish: workflow },
        harness: { adapter: { type: "kysely-sqlite" }, autoTickHooks: false },
        steps: ({ workflow, runner }) => [
          workflow.create({ workflow: "publish", id: "release" }),
          workflow.event({
            workflow: "publish",
            instanceId: "release",
            event: { type: "approve" },
          }),
          ...(["create", "retry"] as const).flatMap((reason) => [
            workflow.read({
              read: async (ctx) => {
                if (reason === "retry") {
                  const [waiting] = await ctx.state.getSteps("publish", "release");
                  assert(waiting.nextRetryAt);
                  ctx.harness.clock.set(waiting.nextRetryAt);
                }
                vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
                const tick = ctx.harness.tick({
                  workflowName: "retry-event-consumption",
                  instanceId: "release",
                  reason,
                });
                try {
                  await (reason === "create" ? firstEntered : retryEntered).promise;
                  const pump = ctx.harness.deps.stepEmissions.get(
                    workflowStepLivePumpKey("retry-event-consumption", "release"),
                  );
                  assert(pump);
                  pump.observe((emission) => {
                    if (emission.actor === "user") {
                      observed.push(emission.payload);
                    }
                  });
                  await advancePump(pump, 100);
                  await tick;
                  assert(pump.scopeCount() === 0);
                  assert(pump.activeSchedulerLeaseCount() === 0);
                } finally {
                  // Ensure an assertion failure cannot strand the callback during harness cleanup.
                  (reason === "create" ? firstRelease : retryRelease).resolve();
                  await tick;
                  vi.useRealTimers();
                }
              },
            }),
            workflow.read({
              read: (ctx) => ctx.state.getEvents("publish", "release"),
              assert: (events) => {
                expect(events).toMatchObject([
                  { consumedByStepKey: reason === "create" ? null : "do:approve" },
                ]);
              },
            }),
            workflow.read({
              read: (ctx) => ctx.state.getSteps("publish", "release"),
              assert: (steps) => {
                expect(steps).toMatchObject([
                  {
                    status: reason === "create" ? "waiting" : "completed",
                    attempts: reason === "create" ? 1 : 2,
                  },
                ]);
              },
            }),
            runner.drainHooks(),
            runner.restart(),
          ]),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("publish", "release"),
            assert: (status) => {
              expect(status).toMatchObject({ status: "complete", output: "published" });
              expect(observed).toEqual([{ attempt: 1 }, { attempt: 2 }]);
            },
          }),
        ],
      }),
    );
  } finally {
    firstRelease.resolve();
    retryRelease.resolve();
    vi.useRealTimers();
  }
});

test("a sibling's failed final flush wakes an idle leader without new application activity", async () => {
  const externalEntered = Promise.withResolvers<void>();
  const approvalEntered = Promise.withResolvers<void>();
  const releaseExternal = Promise.withResolvers<void>();
  const releaseApproval = Promise.withResolvers<void>();
  const approvalFailed = Promise.withResolvers<unknown>();
  const storageError = new Error("TRANSIENT_SIBLING_FLUSH_FAILURE");
  const queries: string[] = [];
  let failNextRead = false;
  const workflow = defineWorkflow({ name: "retry-sibling-flush" }, async (_event, step) => {
    return await Promise.all([
      step.do("external-call", async () => {
        externalEntered.resolve();
        await releaseExternal.promise;
        return "published";
      }),
      step
        .do("approval", async () => {
          approvalEntered.resolve();
          await releaseApproval.promise;
          return "approved";
        })
        .catch((error: unknown) => {
          // Keep the workflow alive so the idle sibling, rather than a new tick, owns recovery.
          approvalFailed.resolve(error);
          return "approval-flush-failed";
        }),
    ]);
  });
  try {
    await runScenario(
      defineScenario({
        name: "retry-sibling-flush",
        workflows: { publish: workflow },
        harness: {
          adapter: {
            type: "kysely-sqlite",
            uowConfig: {
              onQuery: (query) => queries.push(query.sql),
              instrumentation: {
                beforeRetrieve: () => {
                  if (failNextRead) {
                    failNextRead = false;
                    return { type: "error", error: storageError };
                  }
                  return undefined;
                },
              },
            },
          },
          autoTickHooks: false,
        },
        steps: ({ workflow }) => [
          workflow.create({ workflow: "publish", id: "release" }),
          workflow.read({
            read: async (ctx) => {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              const tick = ctx.harness.tick({
                workflowName: "retry-sibling-flush",
                instanceId: "release",
                reason: "create",
              });
              try {
                await Promise.all([externalEntered.promise, approvalEntered.promise]);
                const pump = ctx.harness.deps.stepEmissions.get(
                  workflowStepLivePumpKey("retry-sibling-flush", "release"),
                );
                assert(pump);
                await advancePump(pump, 100);
                const started = await ctx.state.getEmissions("publish", "release");
                expect(started).toHaveLength(2);
                expect(started).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({
                      stepKey: "do:external-call",
                      payload: { control: "step-started" },
                    }),
                    expect.objectContaining({
                      stepKey: "do:approval",
                      payload: { control: "step-started" },
                    }),
                  ]),
                );
                assert(vi.getTimerCount() === 0);

                // No enqueue or event listener can supply a wake-up for this final, read-only pass.
                failNextRead = true;
                releaseApproval.resolve();
                expect(await approvalFailed.promise).toBe(storageError);
                expect(pump.getFailure()).toBe(storageError);
                assert(pump.activeSchedulerLeaseCount() === 1);
                queries.length = 0;
                await advancePump(pump, 100);
                expect(pump.getFailure()).toBeUndefined();
                expect(queries).toHaveLength(4);
                expect(await ctx.state.getEmissions("publish", "release")).toEqual(started);

                queries.length = 0;
                await advancePump(pump, 54_600);
                expect(queries).toEqual([]);
                assert(vi.getTimerCount() === 0);
              } finally {
                failNextRead = false;
                releaseApproval.resolve();
                releaseExternal.resolve();
                await tick;
                vi.useRealTimers();
              }
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("publish", "release"),
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: ["published", "approval-flush-failed"],
              });
            },
          }),
        ],
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("a failed initial control flush retries without outgoing emissions or listeners", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let failNextWrite = false;
  const workflow = defineWorkflow({ name: "retry-idle-control" }, async (_event, step) => {
    await step.do("external-call", async () => {
      entered.resolve();
      await release.promise;
    });
    return "published";
  });
  try {
    await runScenario(
      defineScenario({
        name: "retry-idle-control",
        workflows: { publish: workflow },
        harness: {
          adapter: {
            type: "kysely-sqlite",
            uowConfig: {
              instrumentation: {
                beforeMutate: ({ mutationOpsCount }) => {
                  if (failNextWrite && mutationOpsCount > 0) {
                    failNextWrite = false;
                    return { type: "error", error: new Error("TRANSIENT_STORAGE_FAILURE") };
                  }
                  return undefined;
                },
              },
            },
          },
          autoTickHooks: false,
        },
        steps: ({ workflow }) => [
          workflow.create({ workflow: "publish", id: "release" }),
          workflow.read({
            read: async (ctx) => {
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              const tick = ctx.harness.tick({
                workflowName: "retry-idle-control",
                instanceId: "release",
                reason: "create",
              });
              try {
                await entered.promise;
                const pump = ctx.harness.deps.stepEmissions.get(
                  workflowStepLivePumpKey("retry-idle-control", "release"),
                );
                assert(pump);
                failNextWrite = true;
                await advancePump(pump, 100);
                assert(pump.getFailure()?.message === "TRANSIENT_STORAGE_FAILURE");
                await advancePump(pump, 100);
                expect(pump.getFailure()).toBeUndefined();
                expect(await ctx.state.getEmissions("publish", "release")).toMatchObject([
                  { payload: { control: "step-started" } },
                ]);
                await advancePump(pump, 54_600);
                assert(pump.getScopeMeta("do:external-call")?.flushCount === 1);
                assert(vi.getTimerCount() === 0);
              } finally {
                failNextWrite = false;
                release.resolve();
                await tick;
                vi.useRealTimers();
              }
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("publish", "release"),
            assert: (status) => {
              expect(status).toMatchObject({ status: "complete", output: "published" });
            },
          }),
        ],
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});
