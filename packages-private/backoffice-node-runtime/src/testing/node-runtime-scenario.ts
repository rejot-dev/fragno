import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { provisionGraftControlDatabase } from "../graft/graft-control-database";
import type { GraftNodeRuntimeStorage } from "../graft/graft-runtime-storage";
import {
  createAuthorityBoundGraftNodeObjectRuntime,
  type NodeObjectActivationEvictionPolicy,
  type NodeRuntimeObjects,
} from "../runtime/node-object-runtime";
import { createManualNodeRuntimeClock, type NodeRuntimeClock } from "../runtime/node-runtime-clock";
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
  background: { drain(): Promise<void> };
  activations: { sweepIdle(): Promise<void> };
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
  background: { drain(): RuntimeScenarioStep<TContext> };
  activations: { sweepIdle(): RuntimeScenarioStep<TContext> };
  clock: { advanceBy(ms: number): RuntimeScenarioStep<TContext> };
};

/** Defines a routing server and authority-bound Graft object factories running in worker threads. */
export type NodeRuntimeScenarioDefinition<TBindings extends NodeRuntimeObjectBindings> = {
  name: string;
  storage: GraftNodeRuntimeStorage;
  initialTimeEpochMs: number;
  objectEviction: NodeObjectActivationEvictionPolicy;
  objects: TBindings;
  server(context: { objects: NodeRuntimeObjects<TBindings>; nowEpochMs(): number }): ScenarioServer;
  steps(
    builders: ScenarioSteps<NodeRuntimeScenarioContext<TBindings>>,
  ): readonly RuntimeScenarioStep<NodeRuntimeScenarioContext<TBindings>>[];
};

/** Creates one filesystem Graft environment per process; each storage has an isolated control log. */
export async function createNodeRuntimeScenarioEnvironment() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-graft-scenarios-"));
  const cacheDirectory = path.join(directory, "cache");
  const remoteDirectory = path.join(directory, "remote");
  const configPath = path.join(directory, "graft.toml");
  try {
    await Promise.all([mkdir(cacheDirectory), mkdir(remoteDirectory)]);
    await writeFile(
      configPath,
      [
        `data_dir = ${JSON.stringify(cacheDirectory)}`,
        "make_default = false",
        "",
        "[remote]",
        'type = "fs"',
        `root = ${JSON.stringify(remoteDirectory)}`,
        "",
      ].join("\n"),
    );
    return {
      createStorage(): GraftNodeRuntimeStorage {
        return { configPath, controlRemoteLogId: provisionGraftControlDatabase(configPath) };
      },
      /** Stop every runtime before removing its shared process-local Graft environment. */
      async cleanup(): Promise<void> {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Starts the production runtime with real authority and a 60-second lease for local scenarios. */
export function createNodeRuntimeScenarioRuntime<
  TBindings extends NodeRuntimeObjectBindings,
>(options: {
  storage: GraftNodeRuntimeStorage;
  objects: TBindings;
  clock: NodeRuntimeClock;
  objectEviction: NodeObjectActivationEvictionPolicy;
}) {
  return createAuthorityBoundGraftNodeObjectRuntime({
    ...options,
    nodeIdentity: {
      nodeId: randomUUID(),
      processGeneration: randomUUID(),
      privateAddress: "ws://127.0.0.1:1/node-object-peer",
      applicationOrigin: "http://127.0.0.1:1",
      compatibilityVersion: 1,
    },
    leasePolicy: {
      leaseDurationMs: 60_000,
      renewalIntervalMs: 10_000,
      renewalRetryIntervalMs: 1_000,
      selfFenceSafetyMarginMs: 5_000,
      maximumClockSkewMs: 0,
    },
    peerRpc: {
      authenticationSecret: "node-runtime-scenario-authentication-secret",
      authenticationWindowMs: 5_000,
    },
    objectProvisioning: { kind: "lazy" },
  });
}

/** Infers each binding's Cap'n Web RPC methods from its importable object definition. */
export function defineNodeRuntimeScenario<TBindings extends NodeRuntimeObjectBindings>(
  definition: NodeRuntimeScenarioDefinition<TBindings>,
): NodeRuntimeScenarioDefinition<TBindings> {
  return definition;
}

/** Runs labeled steps and always stops workers and releases healthy object claims before returning. */
export async function runNodeRuntimeScenario<TBindings extends NodeRuntimeObjectBindings>(
  definition: NodeRuntimeScenarioDefinition<TBindings>,
): Promise<{ journal: { kind: RuntimeScenarioStep<unknown>["kind"]; label: string }[] }> {
  const clock = createManualNodeRuntimeClock(definition.initialTimeEpochMs);
  const objectRuntime = createNodeRuntimeScenarioRuntime({
    storage: definition.storage,
    objects: definition.objects,
    clock: clock.source,
    objectEviction: definition.objectEviction,
  });
  try {
    const objects = objectRuntime.objects;
    const alarms = { tick: () => objectRuntime.tick() };
    const background = { drain: () => objectRuntime.drainWaitUntil() };
    const activations = { sweepIdle: () => objectRuntime.sweepIdleObjects() };
    const scenarioServer = definition.server({ objects, nowEpochMs: clock.nowEpochMs });
    const context: NodeRuntimeScenarioContext<TBindings> = {
      server: {
        fetch: async (request) =>
          await objectRuntime.runWithOutputGate(async () => await scenarioServer.fetch(request)),
      },
      objects,
      alarms,
      background,
      activations,
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
      background: {
        drain: () =>
          defineRuntimeScenarioStep("when", "drain registered object background work", async () => {
            await background.drain();
          }),
      },
      activations: {
        sweepIdle: () =>
          defineRuntimeScenarioStep("when", "sweep idle object activations", async () => {
            await activations.sweepIdle();
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
    await objectRuntime.cleanup();
  }
}
