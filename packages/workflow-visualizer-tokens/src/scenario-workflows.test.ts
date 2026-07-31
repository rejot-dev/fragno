import { assert, describe, expect, it } from "vitest";

import {
  createWorkflowTokenMachine,
  renderWorkflowGraphText,
  visualizeWorkflowSource,
} from "./index.ts";
import type {
  BranchNode,
  GraphNode,
  ParallelNode,
  ParallelStrategy,
  StepNode,
  WorkflowChildNode,
  WorkflowGraph,
  WorkflowNode,
} from "./model.ts";
import { tokenizeWorkflowSource } from "./tokenizer.ts";

const NOOP_WORKFLOW_SOURCE = `defineWorkflow({ name: "noop-workflow" }, async () => ({ ok: true }))`;

const SCENARIO_NO_HOOKS_WORKFLOW_SOURCE = `defineWorkflow({ name: "scenario-no-hooks-workflow" }, async () => ({
      ok: true,
    }))`;

const SIMPLE_WORKFLOW_SOURCE = `defineWorkflow({ name: "simple-workflow" }, async () => {
      return { ok: true };
    })`;

const STEP_WORKFLOW_SOURCE = `defineWorkflow({ name: "step-workflow" }, async (_event, step) => {
      const value = await step.do("compute", () => 42);
      return { value };
    })`;

const EVENTFUL_WORKFLOW_SOURCE = `defineWorkflow({ name: "eventful-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ value: number }>("ready", { type: "ready" });
      const sum = await step.do("sum", () => seed + ready.payload.value);
      return { seed, sum, eventValue: ready.payload.value };
    })`;

const FOR_LOOP_WORKFLOW_SOURCE = `defineWorkflow({ name: "for-loop-workflow" }, async (_event, step) => {
      const values: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        values.push(await step.do("for iteration", () => index + 1));
      }
      return { values };
    })`;

const WHILE_LOOP_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "while-loop-workflow" },
      async (_event, step) => {
        let index = 0;
        let total = 0;
        while (index < 3) {
          total += await step.do("while iteration", () => index + 1);
          index += 1;
        }
        return { total };
      },
    )`;

const PARALLEL_WORKFLOW_SOURCE = `defineWorkflow({ name: "parallel-workflow" }, async (_event, step) => {
      const [alpha, beta] = await Promise.all([
        step.do("alpha", async () => "A"),
        step.do("beta", async () => "B"),
      ]);
      return { alpha, beta };
    })`;

const PARALLEL_SHORT_CIRCUIT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "parallel-short-circuit-workflow" },
      async (_event, step) => {
        const [alpha, beta] = await Promise.all([
          step.waitForEvent("alpha", { type: "alpha" }).then(() => "A"),
          step.do("beta", async () => {
            betaRuns += 1;
            return "B";
          }),
        ]);
        return { alpha, beta };
      },
    )`;

const PARALLEL_DO_SHORT_CIRCUIT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "parallel-do-short-circuit-workflow" },
      async (_event, step) => {
        const [alpha, beta] = await Promise.all([
          step.do("alpha", { retries: { limit: 1, delay: 0, backoff: "constant" } }, async () => {
            alphaRuns += 1;
            if (alphaRuns === 1) {
              throw new Error("RETRY_ALPHA");
            }
            return "A";
          }),
          step.do("beta", async () => {
            betaRuns += 1;
            await new Promise((resolve) => setTimeout(resolve, 0));
            return "B";
          }),
        ]);
        return { alpha, beta };
      },
    )`;

const PARALLEL_RESTART_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "parallel-restart-workflow" },
      async (_event, step) => {
        const [alpha, beta] = await Promise.all([
          step.do("alpha", { retries: { limit: 1, delay: 0, backoff: "constant" } }, async () => {
            alphaRuns += 1;
            if (alphaRuns === 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              throw new Error("RETRY_ALPHA");
            }
            return "A";
          }),
          step.do("beta", async () => {
            betaRuns += 1;
            return "B";
          }),
        ]);
        return { alpha, beta };
      },
    )`;

const RACE_WORKFLOW_SOURCE = `defineWorkflow({ name: "race-workflow" }, async (_event, step) => {
      const raceReturn = await step.do("Promise step", async () => {
        return await Promise.race([
          step.do("Promise first race", async () => {
            await step.sleep("Promise first delay", 1000);
            return "first";
          }),
          step.do("Promise second race", async () => {
            return "second";
          }),
        ]);
      });

      const cached = await step.do("After race", async () => raceReturn);
      return { raceReturn, cached };
    })`;

const RACE_EVENT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "race-event-workflow" },
      async (_event, step) => {
        const raceReturn = await step.do("Promise race", async () => {
          return await Promise.race([
            step.do("slow branch", async () => {
              await step.sleep("slow delay", 1000);
              return "slow";
            }),
            step.waitForEvent("event branch", { type: "ready" }).then(() => "event"),
          ]);
        });

        const cached = await step.do("After race", async () => raceReturn);
        return { raceReturn, cached };
      },
    )`;

const ANY_WORKFLOW_SOURCE = `defineWorkflow({ name: "any-workflow" }, async (_event, step) => {
      const anyReturn = await step.do("Promise any", async () => {
        return await Promise.any([
          step.do("Promise any first", async () => {
            await step.sleep("Promise any first delay", 1000);
            return "first";
          }),
          step.do("Promise any second", async () => {
            return "second";
          }),
        ]);
      });

      return { anyReturn };
    })`;

const SCENARIO_RESTART_RUNNER_SOURCE = `defineWorkflow(
      { name: "scenario-restart-runner" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready" });
        return await step.do("finish", async () => "done");
      },
    )`;

const SCENARIO_RACE_EVENT_SECOND_RUNNER_WINS_SOURCE = `defineWorkflow(
      { name: "scenario-race-event-second-runner-wins" },
      async (_event, step) => {
        const raceReturn = await step.do("Promise race", async () => {
          return await Promise.race([
            step.do("promise sleep branch", async () => {
              runtime.controls.resolve("sleep:started");
              await new Promise((resolve) => setTimeout(resolve, 20));
              return "sleep";
            }),
            step.waitForEvent("event branch", { type: "ready" }).then(() => "event"),
          ]);
        });

        const cached = await step.do("After race", async () => raceReturn);
        return { raceReturn, cached };
      },
    )`;

const SCENARIO_EVENT_BEFORE_WAIT_PERSISTED_SOURCE = `defineWorkflow(
      { name: "scenario-event-before-wait-persisted" },
      async (_event, step) => {
        await step.do("slow promise", async () => {
          runtime.controls.resolve("slow:started");
          await new Promise((resolve) => setTimeout(resolve, 20));
        });

        await step.waitForEvent("ready", { type: "ready" });
        return "done";
      },
    )`;

const SCENARIO_STALE_RUNNER_OCC_SOURCE = `defineWorkflow(
      { name: "scenario-stale-runner-occ" },
      async (_event, step) => {
        const value = await step.do("racy work", async () => {
          invocationCount += 1;
          if (invocationCount === 1) {
            runtime.controls.resolve("first:started");
            await runtime.controls.wait("first:release");
          }
          return "committed";
        });
        return { value };
      },
    )`;

const SCENARIO_CLIENT_RUNNER_EMISSION_RACE_SOURCE = `defineWorkflow(
      { name: "scenario-client-runner-emission-race" },
      async (_event, step) => {
        const value = await step.do("racy client message", async (tx) => {
          invocationCount += 1;
          const runner = invocationCount === 1 ? "first" : "second";
          tx.emit({ runner, message: \`\${runner}:started\` });

          runtime.controls.resolve(\`\${runner}:started\`);
          await runtime.controls.wait(\`\${runner}:release\`);

          tx.emit({ runner, message: \`\${runner}:finished\` });
          return runner;
        });

        const shared = await step.do("shared client message", async (tx) => {
          tx.emit({ runner: value, message: "shared:started" });
          runtime.controls.resolve("shared:started");
          await runtime.controls.wait("shared:release");
          tx.emit({ runner: value, message: "shared:finished" });
          return "shared";
        });

        return { value, shared };
      },
    )`;

const SCENARIO_INDEPENDENT_RUNNERS_SOURCE = `defineWorkflow(
      { name: "scenario-independent-runners" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready" });
        return "done";
      },
    )`;

const SCENARIO_RESTART_SLEEP_SOURCE = `defineWorkflow(
      { name: "scenario-restart-sleep" },
      async (_event, step) => {
        await step.sleep("pause", 1000);
        return "awake";
      },
    )`;

const SCENARIO_RESTART_RUNTIME_SOURCE = `defineWorkflow({ name: "scenario-restart-runtime" }, async () => "ok")`;

const SCENARIO_STEP_EMISSION_WAIT_SOURCE = `defineWorkflow(
      { name: "scenario-step-emission-wait" },
      async (_event, step) => {
        await step.do("approval", async (tx) => {
          tx.emit({ phase: "waiting", approved: false });

          await step.waitForEvent("ready", { type: "ready" });

          tx.emit({ phase: "complete", approved: true });
        });
        return "done";
      },
    )`;

const SCENARIO_CONCURRENT_EVENT_TICKS_SOURCE = `defineWorkflow(
      { name: "scenario-concurrent-event-ticks" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: true }>("ready", {
          type: "ready",
          onConsume: async () => {
            consumeCount += 1;
            runtime.controls.resolve(\`consume:\${consumeCount}:started\`);
            if (consumeCount === 1) {
              await runtime.controls.wait("consume:first:release");
            }
          },
        });

        return { ready: ready.payload };
      },
    )`;

const SCENARIO_CONCURRENT_STEP_EMISSIONS_SOURCE = `defineWorkflow(
      { name: "scenario-concurrent-step-emissions" },
      async (_event, step) => {
        const value = await step.do("racy emitter", async (tx) => {
          invocationCount += 1;
          const attempt = invocationCount;
          if (attempt === 1) {
            runtime.controls.resolve("first:started");
            await runtime.controls.wait("first:release");
          } else {
            runtime.controls.resolve("second:started");
          }

          producedEmissions.push({ attempt, phase: "started" });
          tx.emit({ attempt, phase: "started" });
          producedEmissions.push({ attempt, phase: "finished" });
          tx.emit({ attempt, phase: "finished" });
          return \`attempt-\${attempt}\`;
        });

        return { value };
      },
    )`;

const SCENARIO_STEP_EMISSION_REPLAY_SOURCE = `defineWorkflow(
      { name: "scenario-step-emission-replay" },
      async (_event, step) => {
        await step.do("publish once", async (tx) => {
          publishExecutions += 1;
          tx.emit({ phase: "inside-step" });
        });

        await step.waitForEvent("ready", { type: "ready" });
        return "done";
      },
    )`;

const SCENARIO_STEP_EMISSION_ERROR_SOURCE = `defineWorkflow(
      { name: "scenario-step-emission-error" },
      async (_event, step) => {
        await step.do("fail", async (tx) => {
          tx.emit({ phase: "failing" });
          throw new Error("boom");
        });
      },
    )`;

const SCENARIO_STEP_EMISSION_RETRY_SOURCE = `defineWorkflow(
      { name: "scenario-step-emission-retry" },
      async (_event, step) => {
        await step.do("retry later", { retries: { limit: 1, delay: "1 hour" } }, async (tx) => {
          tx.emit({ phase: "retrying" });
          throw new Error("temporary");
        });
        return "done";
      },
    )`;

const CONTROL_WORKFLOW_SOURCE = `defineWorkflow({ name: "control-workflow" }, async (_event, step) => {
      await step.waitForEvent("ready", { type: "ready" });
      const value = await step.do("await control", async () => {
        return await runtime.controls.wait<boolean>("control:ready");
      });
      return { value };
    })`;

const FETCH_WORKFLOW_SOURCE = `defineWorkflow({ name: "fetch-workflow" }, async (_event, step) => {
      const response = await step.do("fetch", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { status: 200, json: { ok: true, source: "fake" } };
      });
      return response;
    })`;

const WAIT_WORKFLOW_SOURCE = `defineWorkflow({ name: "wait-workflow" }, async (_event, step) => {
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      return { ok: ready.payload.ok };
    })`;

const SLEEP_WORKFLOW_SOURCE = `defineWorkflow({ name: "sleep-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    })`;

const SLEEP_WAKE_WORKFLOW_SOURCE = `defineWorkflow({ name: "sleep-wake-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    })`;

const SEQUENTIAL_SLEEP_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "sequential-sleep-workflow" },
      async (_event, step) => {
        await step.sleep("first", "10 minutes");
        await step.sleep("second", "10 minutes");
        return { done: true };
      },
    )`;

const SLEEP_EARLY_WORKFLOW_SOURCE = `defineWorkflow({ name: "sleep-early-workflow" }, async (_event, step) => {
      await step.sleep("nap", "10 minutes");
      return { done: true };
    })`;

const SLEEP_REPLAY_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "sleep-replay-workflow" },
      async (_event, step) => {
        await step.sleep("nap", "10 minutes");
        return { done: true };
      },
    )`;

const SLEEP_UNTIL_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "sleep-until-workflow" },
      async (_event, step) => {
        if (!wakeAt) {
          throw new Error("MISSING_WAKE_AT");
        }
        await step.sleepUntil("alarm", wakeAt);
        return { done: true };
      },
    )`;

const EARLY_EVENT_TIMEOUT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "early-event-timeout-workflow" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
        return { ok: true };
      },
    )`;

const EVENT_TIMEOUT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "event-timeout-workflow" },
      async (_event, step) => {
        await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
        return { ok: true };
      },
    )`;

const GRACEFUL_TIMEOUT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "graceful-timeout-workflow" },
      async (_event, step) => {
        try {
          await step.waitForEvent("ready", { type: "ready", timeout: "5 minutes" });
          return { ok: true, timedOut: false };
        } catch (err) {
          if (err instanceof WaitForEventTimeoutError) {
            return { ok: true, timedOut: true };
          }
          throw err;
        }
      },
    )`;

const TIMEOUT_MUTATION_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "timeout-mutation-workflow" },
      async (_event, step) => {
        await step.do("init", (tx) => {
          tx.mutate((ctx) => {
            ctx.forSchema(timeoutMutationSchema).create("session_status", { status: "waiting" });
          });
          return "initialized";
        });

        try {
          await step.waitForEvent("approval", { type: "approval", timeout: "5 minutes" });
          await step.do("mark-approved", (tx) => {
            tx.mutate((ctx) => {
              ctx.forSchema(timeoutMutationSchema).create("session_status", { status: "approved" });
            });
            return "approved";
          });
          return { finalStatus: "approved" };
        } catch (err) {
          if (err instanceof WaitForEventTimeoutError) {
            await step.do("mark-timed-out", (tx) => {
              tx.onTerminalError.mutate((ctx) => {
                ctx
                  .forSchema(timeoutMutationSchema)
                  .create("session_status", { status: "error-cleanup" });
              });
              tx.mutate((ctx) => {
                ctx.forSchema(timeoutMutationSchema).create("session_status", { status: "done" });
              });
              return "timed-out";
            });
            return { finalStatus: "timed-out" };
          }
          throw err;
        }
      },
    )`;

const WAIT_FOR_EVENT_ON_CONSUME_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "wait-for-event-on-consume-workflow" },
      async (_event, step) => {
        const approval = await step.waitForEvent<{ approvalId: string; decision: string }>(
          "approval",
          {
            type: "approval",
            onConsume: (tx, event) => {
              tx.mutate((ctx) => {
                ctx.forSchema(consumeMutationSchema).create("consumed_event", {
                  approvalId: event.payload.approvalId,
                  decision: event.payload.decision,
                });
              });
              tx.serviceCalls(() => [
                consumeMutationFragment.services.consumedEvents.record(
                  event.payload.approvalId,
                  "service-approved",
                ) as AnyTxResult,
              ]);
              tx.emit({
                type: "approval_consumed",
                approvalId: event.payload.approvalId,
                decision: event.payload.decision,
              });
            },
          },
        );
        return { decision: approval.payload.decision };
      },
    )`;

const EVENT_BEFORE_TIMEOUT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "event-before-timeout-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", {
          type: "ready",
          timeout: "5 minutes",
        });
        return { ok: ready.payload.ok };
      },
    )`;

const HISTORY_WORKFLOW_SOURCE = `defineWorkflow({ name: "history-workflow" }, async (_event, step) => {
      const seed = await step.do("seed", () => 3);
      const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
      const result = await step.do("result", () => (ready.payload.ok ? seed + 1 : seed));
      return { result };
    })`;

const EVENT_ORDER_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "event-order-workflow" },
      async (_event, step) => {
        const first = await step.waitForEvent<{ value: number }>("first", { type: "ready" });
        const second = await step.waitForEvent<{ value: number }>("second", { type: "ready" });
        return { first: first.payload.value, second: second.payload.value };
      },
    )`;

const EVENT_REASON_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "event-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    )`;

const RESUME_REASON_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "resume-reason-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    )`;

const PAUSE_EVENT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "pause-event-workflow" },
      async (_event, step) => {
        const ready = await step.waitForEvent<{ ok: boolean }>("ready", { type: "ready" });
        return { ok: ready.payload.ok };
      },
    )`;

const MUTATE_WORKFLOW_SOURCE = `defineWorkflow({ name: "mutate-workflow" }, async (event, step) => {
      const note = \`fromTx-\${event.instanceId}\`;
      const result = await step.do("mutate", (tx) => {
        tx.mutate((ctx) => {
          ctx.forSchema(mutationsSchema).create("mutation_record", { note });
        });
        return "mutated";
      });
      return { result };
    })`;

const SERVICE_CALL_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "service-call-workflow" },
      async (_event, step) => {
        await step.do("call", (tx) => {
          tx.serviceCalls(() => [serviceCallFragment.services.listRecords()]);
          return "active";
        });
        return { ok: true };
      },
    )`;

const RETRY_WORKFLOW_SOURCE = `defineWorkflow({ name: "retry-workflow" }, async (_event, step) => {
      const result = await step.do(
        "unstable",
        { retries: { limit: 1, delay: 0, backoff: "constant" } },
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("RETRY_ME");
          }
          return "ok";
        },
      );
      return { result };
    })`;

const SCENARIO_MANAGEMENT_RETRY_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "scenario-management-retry-workflow" },
      async (_event, step) => {
        const stable = await step.do("stable", () => {
          stableRuns += 1;
          return "stable";
        });
        const flaky = await step.do("flaky", () => {
          flakyRuns += 1;
          if (flakyRuns === 1) {
            throw new Error("MANUAL_RETRY");
          }
          return "ok";
        });
        return { stable, flaky };
      },
    )`;

const RETRY_EARLY_WORKFLOW_SOURCE = `defineWorkflow({ name: "retry-early-workflow" }, async (_event, step) => {
      const result = await step.do(
        "unstable",
        { retries: { limit: 1, delay: "5 minutes", backoff: "constant" } },
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("RETRY_ME");
          }
          return "ok";
        },
      );
      return { result };
    })`;

const ERROR_WORKFLOW_SOURCE = `defineWorkflow({ name: "error-workflow" }, async (_event, step) => {
      await step.do("boom", () => {
        throw new Error("BOOM");
      });
      return { ok: true };
    })`;

const PAUSE_MANAGEMENT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "pause-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    )`;

const TERMINATE_MANAGEMENT_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "terminate-management-workflow" },
      async (_event, step) => {
        const value = await step.do("count", () => {
          runs += 1;
          return runs;
        });
        return { value };
      },
    )`;

const TERMINATE_SLEEP_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "terminate-sleep-workflow" },
      async (_event, step) => {
        await step.sleep("nap", "10 minutes");
        return { done: true };
      },
    )`;

const BATCH_WORKFLOW_SOURCE = `defineWorkflow({ name: "batch-workflow" }, async (event, step) => {
      const result = await step.do("result", () => ({
        instanceId: event.instanceId,
      }));
      return result;
    })`;

const BATCH_SKIP_WORKFLOW_SOURCE = `defineWorkflow({ name: "batch-skip-workflow" }, async (event, step) => {
      const value = await step.do("result", () => event.instanceId);
      return { value };
    })`;

const BATCH_ROUTE_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "batch-route-workflow" },
      async (_event, step) => {
        const value = await step.do("result", () => "ok");
        return { value };
      },
    )`;

const SCENARIO_STEP_EMISSIONS_SOURCE = `defineWorkflow<"scenario-step-emissions", undefined, { ok: true }>(
      { name: "scenario-step-emissions" },
      async (_event, step) => {
        await step.do("stream", async (tx) => {
          tx.emit({ type: "phase", phase: "started" });
          runtime.controls.resolve("stream:started");
          await runtime.controls.wait("stream:release");
          tx.emit({ type: "phase", phase: "complete" });
        });
        return { ok: true };
      },
    )`;

const SCENARIO_STEP_INBOUND_EMISSIONS_SOURCE = `defineWorkflow<
      "scenario-step-inbound-emissions",
      undefined,
      { ok: true }
    >({ name: "scenario-step-inbound-emissions" }, async (_event, step) => {
      await step.do("interactive", async (tx) => {
        tx.onEvent("command", (event) => {
          received.push(event.payload);
          event.consume();
          runtime.controls.resolve("message:received");
        });
        runtime.controls.resolve("step:ready");
        await runtime.controls.wait("step:release");
      });
      return { ok: true };
    })`;

const SERVICE_STEP_MESSAGE_REPLAY_SOURCE = `defineWorkflow<
      "service-step-message-replay",
      undefined,
      { ok: true }
    >({ name: "service-step-message-replay" }, async (_event, step) => {
      await step.do("first interactive", async (tx) => {
        tx.onEvent("command", (event) => {
          received.push({ step: "first", message: event.payload });
          event.consume();
          runtime.controls.resolve("message:first:received");
        });
        runtime.controls.resolve("step:first:ready");
        await runtime.controls.wait("step:first:release");
      });

      await step.do("second interactive", async (tx) => {
        tx.onEvent("command", (event) => {
          received.push({ step: "second", message: event.payload });
        });
        runtime.controls.resolve("step:second:ready");
        await new Promise((resolve) => setTimeout(resolve, 250));
      });

      return { ok: true };
    })`;

const EMITTING_STEP_WORKFLOW_SOURCE = `defineWorkflow(
      { name: "emitting-step-workflow" },
      async (_event, step) => {
        await step.do("stream", async (tx) => {
          tx.emit({ phase: "streaming", count: 1 });
        });
        return { ok: true };
      },
    )`;

const SCENARIO_WORKFLOW_SOURCES = new Map<string, string>([
  ["noop-workflow", NOOP_WORKFLOW_SOURCE],
  ["scenario-no-hooks-workflow", SCENARIO_NO_HOOKS_WORKFLOW_SOURCE],
  ["simple-workflow", SIMPLE_WORKFLOW_SOURCE],
  ["step-workflow", STEP_WORKFLOW_SOURCE],
  ["eventful-workflow", EVENTFUL_WORKFLOW_SOURCE],
  ["for-loop-workflow", FOR_LOOP_WORKFLOW_SOURCE],
  ["while-loop-workflow", WHILE_LOOP_WORKFLOW_SOURCE],
  ["parallel-workflow", PARALLEL_WORKFLOW_SOURCE],
  ["parallel-short-circuit-workflow", PARALLEL_SHORT_CIRCUIT_WORKFLOW_SOURCE],
  ["parallel-do-short-circuit-workflow", PARALLEL_DO_SHORT_CIRCUIT_WORKFLOW_SOURCE],
  ["parallel-restart-workflow", PARALLEL_RESTART_WORKFLOW_SOURCE],
  ["race-workflow", RACE_WORKFLOW_SOURCE],
  ["race-event-workflow", RACE_EVENT_WORKFLOW_SOURCE],
  ["any-workflow", ANY_WORKFLOW_SOURCE],
  ["scenario-restart-runner", SCENARIO_RESTART_RUNNER_SOURCE],
  ["scenario-race-event-second-runner-wins", SCENARIO_RACE_EVENT_SECOND_RUNNER_WINS_SOURCE],
  ["scenario-event-before-wait-persisted", SCENARIO_EVENT_BEFORE_WAIT_PERSISTED_SOURCE],
  ["scenario-stale-runner-occ", SCENARIO_STALE_RUNNER_OCC_SOURCE],
  ["scenario-client-runner-emission-race", SCENARIO_CLIENT_RUNNER_EMISSION_RACE_SOURCE],
  ["scenario-independent-runners", SCENARIO_INDEPENDENT_RUNNERS_SOURCE],
  ["scenario-restart-sleep", SCENARIO_RESTART_SLEEP_SOURCE],
  ["scenario-restart-runtime", SCENARIO_RESTART_RUNTIME_SOURCE],
  ["scenario-step-emission-wait", SCENARIO_STEP_EMISSION_WAIT_SOURCE],
  ["scenario-concurrent-event-ticks", SCENARIO_CONCURRENT_EVENT_TICKS_SOURCE],
  ["scenario-concurrent-step-emissions", SCENARIO_CONCURRENT_STEP_EMISSIONS_SOURCE],
  ["scenario-step-emission-replay", SCENARIO_STEP_EMISSION_REPLAY_SOURCE],
  ["scenario-step-emission-error", SCENARIO_STEP_EMISSION_ERROR_SOURCE],
  ["scenario-step-emission-retry", SCENARIO_STEP_EMISSION_RETRY_SOURCE],
  ["control-workflow", CONTROL_WORKFLOW_SOURCE],
  ["fetch-workflow", FETCH_WORKFLOW_SOURCE],
  ["wait-workflow", WAIT_WORKFLOW_SOURCE],
  ["sleep-workflow", SLEEP_WORKFLOW_SOURCE],
  ["sleep-wake-workflow", SLEEP_WAKE_WORKFLOW_SOURCE],
  ["sequential-sleep-workflow", SEQUENTIAL_SLEEP_WORKFLOW_SOURCE],
  ["sleep-early-workflow", SLEEP_EARLY_WORKFLOW_SOURCE],
  ["sleep-replay-workflow", SLEEP_REPLAY_WORKFLOW_SOURCE],
  ["sleep-until-workflow", SLEEP_UNTIL_WORKFLOW_SOURCE],
  ["early-event-timeout-workflow", EARLY_EVENT_TIMEOUT_WORKFLOW_SOURCE],
  ["event-timeout-workflow", EVENT_TIMEOUT_WORKFLOW_SOURCE],
  ["graceful-timeout-workflow", GRACEFUL_TIMEOUT_WORKFLOW_SOURCE],
  ["timeout-mutation-workflow", TIMEOUT_MUTATION_WORKFLOW_SOURCE],
  ["wait-for-event-on-consume-workflow", WAIT_FOR_EVENT_ON_CONSUME_WORKFLOW_SOURCE],
  ["event-before-timeout-workflow", EVENT_BEFORE_TIMEOUT_WORKFLOW_SOURCE],
  ["history-workflow", HISTORY_WORKFLOW_SOURCE],
  ["event-order-workflow", EVENT_ORDER_WORKFLOW_SOURCE],
  ["event-reason-workflow", EVENT_REASON_WORKFLOW_SOURCE],
  ["resume-reason-workflow", RESUME_REASON_WORKFLOW_SOURCE],
  ["pause-event-workflow", PAUSE_EVENT_WORKFLOW_SOURCE],
  ["mutate-workflow", MUTATE_WORKFLOW_SOURCE],
  ["service-call-workflow", SERVICE_CALL_WORKFLOW_SOURCE],
  ["retry-workflow", RETRY_WORKFLOW_SOURCE],
  ["scenario-management-retry-workflow", SCENARIO_MANAGEMENT_RETRY_WORKFLOW_SOURCE],
  ["retry-early-workflow", RETRY_EARLY_WORKFLOW_SOURCE],
  ["error-workflow", ERROR_WORKFLOW_SOURCE],
  ["pause-management-workflow", PAUSE_MANAGEMENT_WORKFLOW_SOURCE],
  ["terminate-management-workflow", TERMINATE_MANAGEMENT_WORKFLOW_SOURCE],
  ["terminate-sleep-workflow", TERMINATE_SLEEP_WORKFLOW_SOURCE],
  ["batch-workflow", BATCH_WORKFLOW_SOURCE],
  ["batch-skip-workflow", BATCH_SKIP_WORKFLOW_SOURCE],
  ["batch-route-workflow", BATCH_ROUTE_WORKFLOW_SOURCE],
  ["scenario-step-emissions", SCENARIO_STEP_EMISSIONS_SOURCE],
  ["scenario-step-inbound-emissions", SCENARIO_STEP_INBOUND_EMISSIONS_SOURCE],
  ["service-step-message-replay", SERVICE_STEP_MESSAGE_REPLAY_SOURCE],
  ["emitting-step-workflow", EMITTING_STEP_WORKFLOW_SOURCE],
]);

const PARALLEL_WORKFLOWS: Array<{
  name: string;
  strategy: ParallelStrategy;
  parentLabel: string;
  branchLabels: string[];
}> = [
  {
    name: "parallel-workflow",
    strategy: "all",
    parentLabel: "workflow",
    branchLabels: ["alpha", "beta"],
  },
  {
    name: "parallel-short-circuit-workflow",
    strategy: "all",
    parentLabel: "workflow",
    branchLabels: ["alpha", "beta"],
  },
  {
    name: "parallel-do-short-circuit-workflow",
    strategy: "all",
    parentLabel: "workflow",
    branchLabels: ["alpha", "beta"],
  },
  {
    name: "parallel-restart-workflow",
    strategy: "all",
    parentLabel: "workflow",
    branchLabels: ["alpha", "beta"],
  },
  {
    name: "race-workflow",
    strategy: "race",
    parentLabel: "Promise step",
    branchLabels: ["Promise first race", "Promise second race"],
  },
  {
    name: "race-event-workflow",
    strategy: "race",
    parentLabel: "Promise race",
    branchLabels: ["slow branch", "event branch"],
  },
  {
    name: "scenario-race-event-second-runner-wins",
    strategy: "race",
    parentLabel: "Promise race",
    branchLabels: ["promise sleep branch", "event branch"],
  },
  {
    name: "any-workflow",
    strategy: "any",
    parentLabel: "Promise any",
    branchLabels: ["Promise any first", "Promise any second"],
  },
];

describe("scenario-runner workflow corpus", () => {
  it("contains every workflow copied from the scenario runner", () => {
    assert.equal(SCENARIO_WORKFLOW_SOURCES.size, 64);
  });

  it("visualizes noop-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("noop-workflow", NOOP_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`"workflow noop-workflow"`);
  });

  it("visualizes scenario-no-hooks-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-no-hooks-workflow",
      SCENARIO_NO_HOOKS_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(
      `"workflow scenario-no-hooks-workflow"`,
    );
  });

  it("visualizes simple-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("simple-workflow", SIMPLE_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow simple-workflow
      └─ 0. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes step-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("step-workflow", STEP_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow step-workflow
      ├─ 0. do compute
      │  returns: 42
      └─ 1. terminal final return
         value: { value }"
    `);
  });

  it("visualizes eventful-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("eventful-workflow", EVENTFUL_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow eventful-workflow
      ├─ 0. do seed
      │  returns: 3
      ├─ 1. waitForEvent ready
      │  event: ready
      ├─ 2. do sum
      │  returns: seed + ready.payload.value
      └─ 3. terminal final return
         value: { seed, sum, eventValue: ready.payload.value }"
    `);
  });

  it("visualizes for-loop-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("for-loop-workflow", FOR_LOOP_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow for-loop-workflow
      ├─ 0. for let index = 0; index < 3; index += 1
      │  └─ 0. do for iteration
      │     returns: index + 1
      └─ 1. terminal final return
         value: { values }"
    `);
  });

  it("visualizes while-loop-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("while-loop-workflow", WHILE_LOOP_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow while-loop-workflow
      ├─ 0. while index < 3
      │  └─ 0. do while iteration
      │     returns: index + 1
      └─ 1. terminal final return
         value: { total }"
    `);
  });

  it("visualizes parallel-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("parallel-workflow", PARALLEL_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow parallel-workflow
      ├─ 0. parallel Promise.all
      │  ├─ branch 1
      │  │  └─ 0. do alpha
      │  │     returns: "A"
      │  └─ branch 2
      │     └─ 0. do beta
      │        returns: "B"
      └─ 1. terminal final return
         value: { alpha, beta }"
    `);
  });

  it("visualizes parallel-short-circuit-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "parallel-short-circuit-workflow",
      PARALLEL_SHORT_CIRCUIT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow parallel-short-circuit-workflow
      ├─ 0. parallel Promise.all
      │  ├─ branch 1
      │  │  └─ 0. waitForEvent alpha
      │  │     event: alpha
      │  └─ branch 2
      │     └─ 0. do beta
      │        returns: "B"
      └─ 1. terminal final return
         value: { alpha, beta }"
    `);
  });

  it("visualizes parallel-do-short-circuit-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "parallel-do-short-circuit-workflow",
      PARALLEL_DO_SHORT_CIRCUIT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow parallel-do-short-circuit-workflow
      ├─ 0. parallel Promise.all
      │  ├─ branch 1
      │  │  └─ 0. do alpha
      │  │     returns: "A"
      │  └─ branch 2
      │     └─ 0. do beta
      │        returns: "B"
      └─ 1. terminal final return
         value: { alpha, beta }"
    `);
  });

  it("visualizes parallel-restart-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "parallel-restart-workflow",
      PARALLEL_RESTART_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow parallel-restart-workflow
      ├─ 0. parallel Promise.all
      │  ├─ branch 1
      │  │  └─ 0. do alpha
      │  │     returns: "A"
      │  └─ branch 2
      │     └─ 0. do beta
      │        returns: "B"
      └─ 1. terminal final return
         value: { alpha, beta }"
    `);
  });

  it("visualizes race-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("race-workflow", RACE_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow race-workflow
      ├─ 0. do Promise step
      │  returns: await Promise.race([ step.do("Promise first race", async () => { await step.sleep("Promise first delay", 1000); return "first"; }), step.do("Promise second race", async () => { return "second"; }), ])
      │  └─ 0. parallel Promise.race
      │     ├─ branch 1
      │     │  └─ 0. do Promise first race
      │     │     returns: "first"
      │     │     └─ 0. sleep Promise first delay
      │     └─ branch 2
      │        └─ 0. do Promise second race
      │           returns: "second"
      ├─ 1. do After race
      │  returns: raceReturn
      └─ 2. terminal final return
         value: { raceReturn, cached }"
    `);
  });

  it("visualizes race-event-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("race-event-workflow", RACE_EVENT_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow race-event-workflow
      ├─ 0. do Promise race
      │  returns: await Promise.race([ step.do("slow branch", async () => { await step.sleep("slow delay", 1000); return "slow"; }), step.waitForEvent("event branch", { type: "ready" }).then(() => "event"), ])
      │  └─ 0. parallel Promise.race
      │     ├─ branch 1
      │     │  └─ 0. do slow branch
      │     │     returns: "slow"
      │     │     └─ 0. sleep slow delay
      │     └─ branch 2
      │        └─ 0. waitForEvent event branch
      │           event: ready
      ├─ 1. do After race
      │  returns: raceReturn
      └─ 2. terminal final return
         value: { raceReturn, cached }"
    `);
  });

  it("visualizes any-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("any-workflow", ANY_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow any-workflow
      ├─ 0. do Promise any
      │  returns: await Promise.any([ step.do("Promise any first", async () => { await step.sleep("Promise any first delay", 1000); return "first"; }), step.do("Promise any second", async () => { return "second"; }), ])
      │  └─ 0. parallel Promise.any
      │     ├─ branch 1
      │     │  └─ 0. do Promise any first
      │     │     returns: "first"
      │     │     └─ 0. sleep Promise any first delay
      │     └─ branch 2
      │        └─ 0. do Promise any second
      │           returns: "second"
      └─ 1. terminal final return
         value: { anyReturn }"
    `);
  });

  it("visualizes scenario-restart-runner", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-restart-runner",
      SCENARIO_RESTART_RUNNER_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-restart-runner
      ├─ 0. waitForEvent ready
      │  event: ready
      ├─ 1. do finish
      │  returns: "done"
      └─ 2. terminal final return"
    `);
  });

  it("visualizes scenario-race-event-second-runner-wins", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-race-event-second-runner-wins",
      SCENARIO_RACE_EVENT_SECOND_RUNNER_WINS_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-race-event-second-runner-wins
      ├─ 0. do Promise race
      │  returns: await Promise.race([ step.do("promise sleep branch", async () => { runtime.controls.resolve("sleep:started"); await new Promise((resolve) => setTimeout(resolve, 20)); return "sleep"; }), step.waitForEvent("event branch", { type: "ready" }).then(() => "event"), ])
      │  └─ 0. parallel Promise.race
      │     ├─ branch 1
      │     │  └─ 0. do promise sleep branch
      │     │     returns: "sleep"
      │     └─ branch 2
      │        └─ 0. waitForEvent event branch
      │           event: ready
      ├─ 1. do After race
      │  returns: raceReturn
      └─ 2. terminal final return
         value: { raceReturn, cached }"
    `);
  });

  it("visualizes scenario-event-before-wait-persisted", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-event-before-wait-persisted",
      SCENARIO_EVENT_BEFORE_WAIT_PERSISTED_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-event-before-wait-persisted
      ├─ 0. do slow promise
      ├─ 1. waitForEvent ready
      │  event: ready
      └─ 2. terminal final return
         value: "done""
    `);
  });

  it("visualizes scenario-stale-runner-occ", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-stale-runner-occ",
      SCENARIO_STALE_RUNNER_OCC_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-stale-runner-occ
      ├─ 0. do racy work
      │  returns: "committed"
      └─ 1. terminal final return
         value: { value }"
    `);
  });

  it("visualizes scenario-client-runner-emission-race", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-client-runner-emission-race",
      SCENARIO_CLIENT_RUNNER_EMISSION_RACE_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-client-runner-emission-race
      ├─ 0. do racy client message
      │  returns: runner
      ├─ 1. do shared client message
      │  returns: "shared"
      └─ 2. terminal final return
         value: { value, shared }"
    `);
  });

  it("visualizes scenario-independent-runners", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-independent-runners",
      SCENARIO_INDEPENDENT_RUNNERS_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-independent-runners
      ├─ 0. waitForEvent ready
      │  event: ready
      └─ 1. terminal final return
         value: "done""
    `);
  });

  it("visualizes scenario-restart-sleep", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-restart-sleep",
      SCENARIO_RESTART_SLEEP_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-restart-sleep
      ├─ 0. sleep pause
      └─ 1. terminal final return
         value: "awake""
    `);
  });

  it("visualizes scenario-restart-runtime", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-restart-runtime",
      SCENARIO_RESTART_RUNTIME_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(
      `"workflow scenario-restart-runtime"`,
    );
  });

  it("visualizes scenario-step-emission-wait", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-step-emission-wait",
      SCENARIO_STEP_EMISSION_WAIT_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-step-emission-wait
      ├─ 0. do approval
      │  └─ 0. waitForEvent ready
      │     event: ready
      └─ 1. terminal final return
         value: "done""
    `);
  });

  it("visualizes scenario-concurrent-event-ticks", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-concurrent-event-ticks",
      SCENARIO_CONCURRENT_EVENT_TICKS_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-concurrent-event-ticks
      ├─ 0. waitForEvent ready
      │  event: ready
      └─ 1. terminal final return
         value: { ready: ready.payload }"
    `);
  });

  it("visualizes scenario-concurrent-step-emissions", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-concurrent-step-emissions",
      SCENARIO_CONCURRENT_STEP_EMISSIONS_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-concurrent-step-emissions
      ├─ 0. do racy emitter
      │  returns: \`attempt-\${attempt}\`
      └─ 1. terminal final return
         value: { value }"
    `);
  });

  it("visualizes scenario-step-emission-replay", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-step-emission-replay",
      SCENARIO_STEP_EMISSION_REPLAY_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-step-emission-replay
      ├─ 0. do publish once
      ├─ 1. waitForEvent ready
      │  event: ready
      └─ 2. terminal final return
         value: "done""
    `);
  });

  it("visualizes scenario-step-emission-error", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-step-emission-error",
      SCENARIO_STEP_EMISSION_ERROR_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-step-emission-error
      └─ 0. do fail"
    `);
  });

  it("visualizes scenario-step-emission-retry", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-step-emission-retry",
      SCENARIO_STEP_EMISSION_RETRY_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-step-emission-retry
      ├─ 0. do retry later
      └─ 1. terminal final return
         value: "done""
    `);
  });

  it("visualizes control-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("control-workflow", CONTROL_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow control-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      ├─ 1. do await control
      │  returns: await runtime.controls.wait<boolean>("control:ready")
      └─ 2. terminal final return
         value: { value }"
    `);
  });

  it("visualizes fetch-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("fetch-workflow", FETCH_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow fetch-workflow
      ├─ 0. do fetch
      │  returns: { status: 200, json: { ok: true, source: "fake" } }
      └─ 1. terminal final return
         value: response"
    `);
  });

  it("visualizes wait-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("wait-workflow", WAIT_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow wait-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      └─ 1. terminal final return
         value: { ok: ready.payload.ok }"
    `);
  });

  it("visualizes sleep-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("sleep-workflow", SLEEP_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow sleep-workflow
      ├─ 0. sleep nap
      │  duration: 10 minutes
      └─ 1. terminal final return
         value: { done: true }"
    `);
  });

  it("visualizes sleep-wake-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("sleep-wake-workflow", SLEEP_WAKE_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow sleep-wake-workflow
      ├─ 0. sleep nap
      │  duration: 10 minutes
      └─ 1. terminal final return
         value: { done: true }"
    `);
  });

  it("visualizes sequential-sleep-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "sequential-sleep-workflow",
      SEQUENTIAL_SLEEP_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow sequential-sleep-workflow
      ├─ 0. sleep first
      │  duration: 10 minutes
      ├─ 1. sleep second
      │  duration: 10 minutes
      └─ 2. terminal final return
         value: { done: true }"
    `);
  });

  it("visualizes sleep-early-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("sleep-early-workflow", SLEEP_EARLY_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow sleep-early-workflow
      ├─ 0. sleep nap
      │  duration: 10 minutes
      └─ 1. terminal final return
         value: { done: true }"
    `);
  });

  it("visualizes sleep-replay-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "sleep-replay-workflow",
      SLEEP_REPLAY_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow sleep-replay-workflow
      ├─ 0. sleep nap
      │  duration: 10 minutes
      └─ 1. terminal final return
         value: { done: true }"
    `);
  });

  it("visualizes sleep-until-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("sleep-until-workflow", SLEEP_UNTIL_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow sleep-until-workflow
      ├─ 0. if !wakeAt
      │  └─ 0. terminal error MISSING_WAKE_AT
      │     value: new Error("MISSING_WAKE_AT")
      ├─ 1. sleepUntil alarm
      │  until: wakeAt
      └─ 2. terminal final return
         value: { done: true }"
    `);
  });

  it("visualizes early-event-timeout-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "early-event-timeout-workflow",
      EARLY_EVENT_TIMEOUT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow early-event-timeout-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      │  timeout: 5 minutes
      └─ 1. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes event-timeout-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "event-timeout-workflow",
      EVENT_TIMEOUT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow event-timeout-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      │  timeout: 5 minutes
      └─ 1. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes graceful-timeout-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "graceful-timeout-workflow",
      GRACEFUL_TIMEOUT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow graceful-timeout-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      │  timeout: 5 minutes
      ├─ 1. terminal final return
      │  value: { ok: true, timedOut: false }
      ├─ 2. if err instanceof WaitForEventTimeoutError
      │  └─ 0. terminal early return
      │     value: { ok: true, timedOut: true }
      └─ 3. terminal error
         value: err"
    `);
  });

  it("visualizes timeout-mutation-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "timeout-mutation-workflow",
      TIMEOUT_MUTATION_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow timeout-mutation-workflow
      ├─ 0. do init
      │  returns: "initialized"
      ├─ 1. waitForEvent approval
      │  event: approval
      │  timeout: 5 minutes
      ├─ 2. do mark-approved
      │  returns: "approved"
      ├─ 3. terminal final return
      │  value: { finalStatus: "approved" }
      ├─ 4. if err instanceof WaitForEventTimeoutError
      │  ├─ 0. do mark-timed-out
      │  │  returns: "timed-out"
      │  └─ 1. terminal early return
      │     value: { finalStatus: "timed-out" }
      └─ 5. terminal error
         value: err"
    `);
  });

  it("visualizes wait-for-event-on-consume-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "wait-for-event-on-consume-workflow",
      WAIT_FOR_EVENT_ON_CONSUME_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow wait-for-event-on-consume-workflow
      ├─ 0. waitForEvent approval
      │  event: approval_consumed
      └─ 1. terminal final return
         value: { decision: approval.payload.decision }"
    `);
  });

  it("visualizes event-before-timeout-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "event-before-timeout-workflow",
      EVENT_BEFORE_TIMEOUT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow event-before-timeout-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      │  timeout: 5 minutes
      └─ 1. terminal final return
         value: { ok: ready.payload.ok }"
    `);
  });

  it("visualizes history-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("history-workflow", HISTORY_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow history-workflow
      ├─ 0. do seed
      │  returns: 3
      ├─ 1. waitForEvent ready
      │  event: ready
      ├─ 2. do result
      │  returns: (ready.payload.ok ? seed + 1 : seed)
      └─ 3. terminal final return
         value: { result }"
    `);
  });

  it("visualizes event-order-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("event-order-workflow", EVENT_ORDER_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow event-order-workflow
      ├─ 0. waitForEvent first
      │  event: ready
      ├─ 1. waitForEvent second
      │  event: ready
      └─ 2. terminal final return
         value: { first: first.payload.value, second: second.payload.value }"
    `);
  });

  it("visualizes event-reason-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "event-reason-workflow",
      EVENT_REASON_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow event-reason-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      └─ 1. terminal final return
         value: { ok: ready.payload.ok }"
    `);
  });

  it("visualizes resume-reason-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "resume-reason-workflow",
      RESUME_REASON_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow resume-reason-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      └─ 1. terminal final return
         value: { ok: ready.payload.ok }"
    `);
  });

  it("visualizes pause-event-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("pause-event-workflow", PAUSE_EVENT_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow pause-event-workflow
      ├─ 0. waitForEvent ready
      │  event: ready
      └─ 1. terminal final return
         value: { ok: ready.payload.ok }"
    `);
  });

  it("visualizes mutate-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("mutate-workflow", MUTATE_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow mutate-workflow
      ├─ 0. do mutate
      │  returns: "mutated"
      └─ 1. terminal final return
         value: { result }"
    `);
  });

  it("visualizes service-call-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "service-call-workflow",
      SERVICE_CALL_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow service-call-workflow
      ├─ 0. do call
      │  returns: "active"
      └─ 1. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes retry-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("retry-workflow", RETRY_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow retry-workflow
      ├─ 0. do unstable
      │  returns: "ok"
      └─ 1. terminal final return
         value: { result }"
    `);
  });

  it("visualizes scenario-management-retry-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-management-retry-workflow",
      SCENARIO_MANAGEMENT_RETRY_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-management-retry-workflow
      ├─ 0. do stable
      │  returns: "stable"
      ├─ 1. do flaky
      │  returns: "ok"
      └─ 2. terminal final return
         value: { stable, flaky }"
    `);
  });

  it("visualizes retry-early-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("retry-early-workflow", RETRY_EARLY_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow retry-early-workflow
      ├─ 0. do unstable
      │  returns: "ok"
      └─ 1. terminal final return
         value: { result }"
    `);
  });

  it("visualizes error-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("error-workflow", ERROR_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow error-workflow
      ├─ 0. do boom
      └─ 1. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes pause-management-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "pause-management-workflow",
      PAUSE_MANAGEMENT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow pause-management-workflow
      ├─ 0. do count
      │  returns: runs
      └─ 1. terminal final return
         value: { value }"
    `);
  });

  it("visualizes terminate-management-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "terminate-management-workflow",
      TERMINATE_MANAGEMENT_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow terminate-management-workflow
      ├─ 0. do count
      │  returns: runs
      └─ 1. terminal final return
         value: { value }"
    `);
  });

  it("visualizes terminate-sleep-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "terminate-sleep-workflow",
      TERMINATE_SLEEP_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow terminate-sleep-workflow
      ├─ 0. sleep nap
      │  duration: 10 minutes
      └─ 1. terminal final return
         value: { done: true }"
    `);
  });

  it("visualizes batch-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("batch-workflow", BATCH_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow batch-workflow
      ├─ 0. do result
      │  returns: ({ instanceId: event.instanceId, })
      └─ 1. terminal final return
         value: result"
    `);
  });

  it("visualizes batch-skip-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("batch-skip-workflow", BATCH_SKIP_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow batch-skip-workflow
      ├─ 0. do result
      │  returns: event.instanceId
      └─ 1. terminal final return
         value: { value }"
    `);
  });

  it("visualizes batch-route-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix("batch-route-workflow", BATCH_ROUTE_WORKFLOW_SOURCE);
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow batch-route-workflow
      ├─ 0. do result
      │  returns: "ok"
      └─ 1. terminal final return
         value: { value }"
    `);
  });

  it("visualizes scenario-step-emissions", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-step-emissions",
      SCENARIO_STEP_EMISSIONS_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-step-emissions
      ├─ 0. do stream
      └─ 1. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes scenario-step-inbound-emissions", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "scenario-step-inbound-emissions",
      SCENARIO_STEP_INBOUND_EMISSIONS_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow scenario-step-inbound-emissions
      ├─ 0. do interactive
      └─ 1. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes service-step-message-replay", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "service-step-message-replay",
      SERVICE_STEP_MESSAGE_REPLAY_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow service-step-message-replay
      ├─ 0. do first interactive
      ├─ 1. do second interactive
      └─ 2. terminal final return
         value: { ok: true }"
    `);
  });

  it("visualizes emitting-step-workflow", () => {
    const graph = visualizeAtEveryTokenPrefix(
      "emitting-step-workflow",
      EMITTING_STEP_WORKFLOW_SOURCE,
    );
    expect(renderWorkflowGraphText(graph)).toMatchInlineSnapshot(`
      "workflow emitting-step-workflow
      ├─ 0. do stream
      └─ 1. terminal final return
         value: { ok: true }"
    `);
  });
});

describe("scenario-runner parallel workflow structure", () => {
  it.each(PARALLEL_WORKFLOWS)(
    "represents $name as Promise.$strategy branches",
    ({ name, strategy, parentLabel, branchLabels }) => {
      const snapshot = visualizeScenarioWorkflow(name);
      const workflow = snapshot.nodes.find(
        (node): node is WorkflowNode => node.kind === "workflow",
      );
      const parallel = snapshot.nodes.find(
        (node): node is ParallelNode => node.kind === "parallel",
      );

      assert(workflow);
      assert(parallel);
      expect(parallel).toMatchObject({
        label: `Promise.${strategy}`,
        strategy,
        construction: { status: "complete", phase: "complete" },
      });

      if (parentLabel === "workflow") {
        expect(parallel.parentId).toBe(workflow.id);
      } else {
        const parent = stepByLabel(snapshot, parentLabel);
        expect(parallel.parentId).toBe(parent.id);
      }

      const branches = snapshot.nodes
        .filter(
          (node): node is BranchNode => node.kind === "branch" && node.parentId === parallel.id,
        )
        .sort((left, right) => left.index - right.index);
      expect(branches).toHaveLength(branchLabels.length);
      expect(
        branches.map((branch) => {
          const branchStep = snapshot.nodes.find(
            (node): node is StepNode => node.kind === "step" && node.parentId === branch.id,
          );
          assert(branchStep);
          return branchStep.label;
        }),
      ).toEqual(branchLabels);

      for (const branch of branches) {
        expect(snapshot.edges).toContainEqual(
          expect.objectContaining({ from: parallel.id, to: branch.id, type: "contains" }),
        );
      }
      assert(
        !snapshot.edges.some(
          (edge) =>
            edge.type === "sequence" &&
            branches.some((branch) => branch.id === edge.from) &&
            branches.some((branch) => branch.id === edge.to),
        ),
      );
    },
  );

  it("keeps nested durable steps inside their owning branch step", () => {
    const race = visualizeScenarioWorkflow("race-workflow");
    expect(stepByLabel(race, "Promise first delay").parentId).toBe(
      stepByLabel(race, "Promise first race").id,
    );

    const nestedWait = visualizeScenarioWorkflow("scenario-step-emission-wait");
    expect(stepByLabel(nestedWait, "ready").parentId).toBe(stepByLabel(nestedWait, "approval").id);
  });
});

function visualizeAtEveryTokenPrefix(name: string, source: string): WorkflowGraph {
  const path = `scenario-runner/${name}.workflow.ts`;
  const machine = createWorkflowTokenMachine({ path });

  for (const token of tokenizeWorkflowSource(source)) {
    const update = machine.push(token);
    assertUsableGraph(update.graph);
  }

  const graph = machine.finish().graph;
  const workflows = graph.nodes.filter((node): node is WorkflowNode => node.kind === "workflow");
  const durableSteps = graph.nodes.filter((node): node is StepNode => node.kind === "step");

  expect(workflows).toEqual([
    expect.objectContaining({
      name,
      construction: { status: "complete", phase: "complete" },
    }),
  ]);
  assert(durableSteps.every((step) => step.construction.status === "complete"));
  expect(graph.diagnostics).toEqual([]);
  return graph;
}

function visualizeScenarioWorkflow(name: string): WorkflowGraph {
  const source = SCENARIO_WORKFLOW_SOURCES.get(name);
  assert(source !== undefined);
  return visualizeWorkflowSource(`scenario-runner/${name}.workflow.ts`, source).graph;
}

function stepByLabel(graph: WorkflowGraph, label: string): StepNode {
  const step = graph.nodes.find(
    (node): node is StepNode => node.kind === "step" && node.label === label,
  );
  assert(step);
  return step;
}

function assertUsableGraph(graph: WorkflowGraph): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  assert(nodeIds.size === graph.nodes.length);
  for (const edge of graph.edges) {
    assert(nodeIds.has(edge.from));
    assert(nodeIds.has(edge.to));
  }
  for (const node of graph.nodes) {
    if (hasParent(node)) {
      assert(nodeIds.has(node.parentId));
    }
  }
}

function hasParent(node: GraphNode): node is WorkflowChildNode {
  return node.kind !== "workflow";
}
