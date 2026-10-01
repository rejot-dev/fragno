import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodeObjectRuntime, type NodeRuntimeObjects } from "../runtime/node-object-runtime";
import { createManualNodeRuntimeClock } from "../runtime/node-runtime-clock";
import type { NodeRuntimeObjectBindings } from "../runtime/node-runtime-object";
import {
  createRuntimeScenarioStepBuilders,
  defineRuntimeScenarioStep,
  runRuntimeScenarioSteps,
  type RuntimeScenarioStep,
  type RuntimeScenarioStepBuilders,
} from "./runtime-scenario";

type ScenarioServer = { fetch(request: Request): Promise<Response> };

/** Scenario calls cross worker RPC boundaries; explicit alarm ticks target those same object workers. */
export type NodeRuntimeScenarioContext<TBindings extends NodeRuntimeObjectBindings> = {
  server: ScenarioServer;
  objects: NodeRuntimeObjects<TBindings>;
  alarms: { tick(): Promise<void> };
  clock: { nowEpochMs(): number; advanceBy(ms: number): void };
};

type ScenarioSteps<TContext> = RuntimeScenarioStepBuilders<TContext> & {
  server: {
    fetch(
      request: Request,
      assertResponse: (response: Response, context: TContext) => void | Promise<void>,
    ): RuntimeScenarioStep<TContext>;
  };
  alarms: { tick(): RuntimeScenarioStep<TContext> };
  clock: { advanceBy(ms: number): RuntimeScenarioStep<TContext> };
};

/** Defines a routing server and importable SQLite-backed object factories running in worker threads. */
export type NodeRuntimeScenarioDefinition<TBindings extends NodeRuntimeObjectBindings> = {
  name: string;
  initialTimeEpochMs: number;
  objects: TBindings;
  server(context: { objects: NodeRuntimeObjects<TBindings>; nowEpochMs(): number }): ScenarioServer;
  steps(
    builders: ScenarioSteps<NodeRuntimeScenarioContext<TBindings>>,
  ): readonly RuntimeScenarioStep<NodeRuntimeScenarioContext<TBindings>>[];
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
): Promise<{ journal: { kind: RuntimeScenarioStep<unknown>["kind"]; label: string }[] }> {
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
    const scenarioServer = definition.server({ objects, nowEpochMs: clock.nowEpochMs });
    const context: NodeRuntimeScenarioContext<TBindings> = {
      server: {
        fetch: async (request) =>
          await objectRuntime.runWithOutputGate(async () => await scenarioServer.fetch(request)),
      },
      objects,
      alarms,
      clock,
    };
    const builders: ScenarioSteps<typeof context> = {
      ...createRuntimeScenarioStepBuilders("NODE_RUNTIME_SCENARIO_CONCURRENT_STEP_FAILED"),
      server: {
        fetch: (request, assertResponse) =>
          defineRuntimeScenarioStep(
            "when",
            `${request.method} ${request.url}`,
            async (ctx: typeof context) => {
              await assertResponse(await ctx.server.fetch(request), ctx);
            },
          ),
      },
      alarms: {
        tick: () =>
          defineRuntimeScenarioStep("alarm", "tick object alarms", async () => {
            await alarms.tick();
          }),
      },
      clock: {
        advanceBy: (ms) =>
          defineRuntimeScenarioStep("clock", `advance time by ${ms}ms`, (ctx: typeof context) => {
            ctx.clock.advanceBy(ms);
          }),
      },
    };
    return await runRuntimeScenarioSteps({
      name: definition.name,
      context,
      steps: definition.steps(builders),
      stepFailurePrefix: "NODE_RUNTIME_SCENARIO_STEP_FAILED",
    });
  } finally {
    try {
      await runtime?.cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
