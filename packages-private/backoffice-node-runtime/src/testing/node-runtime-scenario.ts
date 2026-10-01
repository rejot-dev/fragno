import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodeObjectRuntime, type NodeRuntimeObjects } from "../runtime/node-object-runtime";
import { createManualNodeRuntimeClock } from "../runtime/node-runtime-clock";
import type { NodeRuntimeObjectBindings } from "../runtime/node-runtime-object";

type ScenarioServer = { fetch(request: Request): Promise<Response> };

/** Scenario calls cross worker RPC boundaries; explicit alarm ticks target those same object workers. */
export type NodeRuntimeScenarioContext<TBindings extends NodeRuntimeObjectBindings> = {
  server: ScenarioServer;
  objects: NodeRuntimeObjects<TBindings>;
  alarms: { tick(): Promise<void> };
  clock: { nowEpochMs(): number; advanceBy(ms: number): void };
};

type ScenarioStep<TContext> = {
  kind: "given" | "when" | "then" | "alarm" | "clock" | "concurrent";
  label: string;
  run(context: TContext): void | Promise<void>;
};
type ScenarioSteps<TContext> = {
  given(label: string, run: ScenarioStep<TContext>["run"]): ScenarioStep<TContext>;
  when(label: string, run: ScenarioStep<TContext>["run"]): ScenarioStep<TContext>;
  then(label: string, run: ScenarioStep<TContext>["run"]): ScenarioStep<TContext>;
  server: {
    fetch(
      request: Request,
      assertResponse: (response: Response, context: TContext) => void | Promise<void>,
    ): ScenarioStep<TContext>;
  };
  alarms: { tick(): ScenarioStep<TContext> };
  clock: { advanceBy(ms: number): ScenarioStep<TContext> };
  concurrent(...steps: ScenarioStep<TContext>[]): ScenarioStep<TContext>;
};

/** Defines a routing server and importable SQLite-backed object factories running in worker threads. */
export type NodeRuntimeScenarioDefinition<TBindings extends NodeRuntimeObjectBindings> = {
  name: string;
  initialTimeEpochMs: number;
  objects: TBindings;
  server(context: { objects: NodeRuntimeObjects<TBindings>; nowEpochMs(): number }): ScenarioServer;
  steps(
    builders: ScenarioSteps<NodeRuntimeScenarioContext<TBindings>>,
  ): readonly ScenarioStep<NodeRuntimeScenarioContext<TBindings>>[];
};

/** Infers each binding's Cap'n Web RPC methods from its importable object definition. */
export function defineNodeRuntimeScenario<TBindings extends NodeRuntimeObjectBindings>(
  definition: NodeRuntimeScenarioDefinition<TBindings>,
): NodeRuntimeScenarioDefinition<TBindings> {
  return definition;
}

/** Runs labeled steps and always stops workers, closes SQLite, and removes the temporary directory. */
export async function runNodeRuntimeScenario<TBindings extends NodeRuntimeObjectBindings>(
  definition: NodeRuntimeScenarioDefinition<TBindings>,
): Promise<{ journal: { kind: ScenarioStep<unknown>["kind"]; label: string }[] }> {
  const clock = createManualNodeRuntimeClock(definition.initialTimeEpochMs);
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-scenario-"));
  let runtime: ReturnType<typeof createNodeObjectRuntime<TBindings>> | null = null;
  try {
    const objectRuntime = createNodeObjectRuntime({
      directory,
      objects: definition.objects,
      clock: clock.source,
    });
    runtime = objectRuntime;
    const objects = objectRuntime.objects;
    const alarms = { tick: () => objectRuntime.tick() };
    const context: NodeRuntimeScenarioContext<TBindings> = {
      server: definition.server({ objects, nowEpochMs: clock.nowEpochMs }),
      objects,
      alarms,
      clock,
    };
    type Step = ScenarioStep<typeof context>;
    function step(kind: Step["kind"], label: string, run: Step["run"]): Step {
      return { kind, label, run };
    }
    const builders: ScenarioSteps<typeof context> = {
      given: (label, run) => step("given", label, run),
      when: (label, run) => step("when", label, run),
      // oxlint-disable-next-line no-thenable -- `then` names an assertion step, not a Promise callback.
      then: (label, run) => step("then", label, run),
      server: {
        fetch: (request, assertResponse) =>
          step("when", `${request.method} ${request.url}`, async (ctx) => {
            await assertResponse(await ctx.server.fetch(request), ctx);
          }),
      },
      alarms: {
        tick: () =>
          step("alarm", "tick object alarms", async () => {
            await alarms.tick();
          }),
      },
      clock: {
        advanceBy: (ms) =>
          step("clock", `advance time by ${ms}ms`, (ctx) => {
            ctx.clock.advanceBy(ms);
          }),
      },
      concurrent: (...steps) =>
        step("concurrent", steps.map(({ label }) => label).join(" | "), async (ctx) => {
          const branches = await Promise.allSettled(
            steps.map(async (branch) => {
              await branch.run(ctx);
            }),
          );
          const failures = branches.flatMap((branch) =>
            branch.status === "rejected" ? [branch.reason as unknown] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, "NODE_RUNTIME_SCENARIO_CONCURRENT_STEP_FAILED");
          }
        }),
    };
    const journal: { kind: Step["kind"]; label: string }[] = [];
    for (const currentStep of definition.steps(builders)) {
      try {
        await currentStep.run(context);
        journal.push({ kind: currentStep.kind, label: currentStep.label });
      } catch (cause) {
        throw new Error(
          `NODE_RUNTIME_SCENARIO_STEP_FAILED:${definition.name}:${currentStep.label}`,
          { cause },
        );
      }
    }
    return { journal };
  } finally {
    try {
      await runtime?.cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
