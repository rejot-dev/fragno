import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LocalDurableObjectNamespace,
  ProcessLocalObjectExecutionCoordinator,
  type BackofficeDurableObjectState,
} from "./local-durable-objects";
import {
  runNodeBackofficeAlarmTick,
  type NodeBackofficeAlarmRuntime,
} from "./node-alarm-scheduler";
import { SqliteDurableObjectState } from "./sqlite-durable-object-state";
import { SqliteObjectCoordination } from "./sqlite-object-coordination";
import { SqliteBackofficeObjectStorage } from "./sqlite-object-storage";

/** Object factories run independently in the main server and each scenario processor. */
export type NodeRuntimeScenarioObjectContext = {
  id: DurableObjectId;
  name: string;
  state: BackofficeDurableObjectState;
  runtimeName: string;
  nowEpochMs(): number;
};

type ScenarioServer = { fetch(request: Request): Promise<Response> };
type ScenarioObjectFactories = Record<
  string,
  (context: NodeRuntimeScenarioObjectContext) => ScenarioServer
>;
type ScenarioObjects<TFactories extends ScenarioObjectFactories> = {
  [K in keyof TFactories]: { get(name: string): ReturnType<TFactories[K]> };
};
type ScenarioProcessorNames = readonly [string, ...string[]];

/** Scenario steps call the main server; only explicit processor ticks deliver alarms. */
export type NodeRuntimeScenarioContext<
  TFactories extends ScenarioObjectFactories,
  TProcessors extends ScenarioProcessorNames,
> = {
  server: ScenarioServer;
  objects: ScenarioObjects<TFactories>;
  processors: { [K in TProcessors[number]]: { tick(): Promise<void> } };
  clock: { nowEpochMs(): number; advanceBy(ms: number): void };
};

type ScenarioStep<TContext> = {
  kind: "given" | "when" | "then" | "processor" | "clock" | "concurrent";
  label: string;
  run(context: TContext): void | Promise<void>;
};
type ScenarioSteps<TContext, TProcessorName extends string> = {
  given(label: string, run: ScenarioStep<TContext>["run"]): ScenarioStep<TContext>;
  when(label: string, run: ScenarioStep<TContext>["run"]): ScenarioStep<TContext>;
  then(label: string, run: ScenarioStep<TContext>["run"]): ScenarioStep<TContext>;
  server: {
    fetch(
      request: Request,
      assertResponse: (response: Response, context: TContext) => void | Promise<void>,
    ): ScenarioStep<TContext>;
  };
  processors: { [K in TProcessorName]: { tick(): ScenarioStep<TContext> } };
  clock: { advanceBy(ms: number): ScenarioStep<TContext> };
  concurrent(...steps: ScenarioStep<TContext>[]): ScenarioStep<TContext>;
};

/** Defines a SQLite-backed main server and at least one independent alarm processor. */
export type NodeRuntimeScenarioDefinition<
  TFactories extends ScenarioObjectFactories,
  TProcessors extends ScenarioProcessorNames,
> = {
  name: string;
  initialTimeEpochMs: number;
  objects: TFactories;
  server(context: { objects: ScenarioObjects<TFactories>; nowEpochMs(): number }): ScenarioServer;
  processors: TProcessors;
  steps(
    builders: ScenarioSteps<
      NodeRuntimeScenarioContext<TFactories, TProcessors>,
      TProcessors[number]
    >,
  ): readonly ScenarioStep<NodeRuntimeScenarioContext<TFactories, TProcessors>>[];
};

/** Infers RPC method signatures from each scenario object factory without widening the registry. */
export function defineNodeRuntimeScenario<
  TFactories extends ScenarioObjectFactories,
  const TProcessors extends ScenarioProcessorNames,
>(
  definition: NodeRuntimeScenarioDefinition<TFactories, TProcessors>,
): NodeRuntimeScenarioDefinition<TFactories, TProcessors> {
  return definition;
}

function createScenarioObjectRuntime<TFactories extends ScenarioObjectFactories>(
  directory: string,
  runtimeName: string,
  factories: TFactories,
  nowEpochMs: () => number,
) {
  const storage = new SqliteBackofficeObjectStorage(directory);
  const coordination = new SqliteObjectCoordination(storage);
  const executionCoordinator = new ProcessLocalObjectExecutionCoordinator();
  const namespaces = new Map<string, LocalDurableObjectNamespace<ScenarioServer>>();
  const objects = Object.fromEntries(
    Object.entries(factories).map(([binding, createObject]) => {
      const namespace = new LocalDurableObjectNamespace({
        name: binding,
        executionCoordinator,
        createState: (id) => new SqliteDurableObjectState(id, storage, coordination),
        createObject: (input) => createObject({ ...input, runtimeName, nowEpochMs }),
      });
      namespaces.set(binding, namespace);
      return [binding, { get: (name: string) => namespace.get(namespace.idFromName(name)) }];
    }),
  ) as ScenarioObjects<TFactories>;

  const alarmRuntime: NodeBackofficeAlarmRuntime = {
    async discoverPersistedObjects() {
      const discoveries = await Promise.allSettled(
        storage.objectIds().map(async (id) => {
          const separator = id.indexOf(":");
          const namespace = namespaces.get(id.slice(0, separator));
          if (!namespace) {
            throw new Error(`NODE_RUNTIME_SCENARIO_UNKNOWN_PERSISTED_OBJECT:${id}`);
          }
          await namespace.discoverPersisted(namespace.idFromName(id.slice(separator + 1)));
        }),
      );
      throwScenarioFailures(discoveries, "NODE_RUNTIME_SCENARIO_DISCOVERY_FAILED");
    },
    async drainAlarms() {
      const now = nowEpochMs();
      const deliveries = await Promise.allSettled(
        [...namespaces.values()].flatMap((namespace) =>
          namespace.instances().flatMap((instance) => {
            const alarm = instance.state.dueAlarm(now);
            return alarm ? [namespace.deliverAlarm(instance, alarm, now)] : [];
          }),
        ),
      );
      throwScenarioFailures(deliveries, "NODE_RUNTIME_SCENARIO_ALARM_DELIVERY_FAILED");
    },
    async drainWaitUntil() {
      const drains = await Promise.allSettled(
        [...namespaces.values()].map(async (namespace) => {
          await namespace.drainWaitUntil();
        }),
      );
      throwScenarioFailures(drains, "NODE_RUNTIME_SCENARIO_WAIT_UNTIL_FAILED");
    },
  };

  return {
    objects,
    async tick() {
      await runNodeBackofficeAlarmTick(alarmRuntime);
    },
    async cleanup() {
      try {
        await executionCoordinator.waitForIdle();
        while (
          [...namespaces.values()].some((namespace) =>
            namespace.instances().some(({ state }) => state.hasPendingWork),
          )
        ) {
          await alarmRuntime.drainWaitUntil();
        }
      } finally {
        await coordination.waitForIdle();
        storage.close();
      }
    },
  };
}

function throwScenarioFailures(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

/** Runs labeled scenario steps and always closes SQLite connections and removes the temporary directory. */
export async function runNodeRuntimeScenario<
  TFactories extends ScenarioObjectFactories,
  const TProcessors extends ScenarioProcessorNames,
>(
  definition: NodeRuntimeScenarioDefinition<TFactories, TProcessors>,
): Promise<{
  journal: { kind: ScenarioStep<unknown>["kind"]; label: string }[];
}> {
  const runtimeNames = ["main", ...definition.processors];
  if (new Set(runtimeNames).size !== runtimeNames.length) {
    throw new Error(
      "NODE_RUNTIME_SCENARIO_DUPLICATE_RUNTIME_NAME: main is reserved and processors must be unique.",
    );
  }
  for (const binding of Object.keys(definition.objects)) {
    if (binding.length === 0 || binding.includes(":")) {
      throw new Error(`NODE_RUNTIME_SCENARIO_INVALID_BINDING:${binding}`);
    }
  }
  if (!Number.isSafeInteger(definition.initialTimeEpochMs) || definition.initialTimeEpochMs < 0) {
    throw new Error(
      "NODE_RUNTIME_SCENARIO_INVALID_INITIAL_TIME: expected nonnegative integer epoch milliseconds.",
    );
  }
  let timeEpochMs = definition.initialTimeEpochMs;
  const clock = {
    nowEpochMs: () => timeEpochMs,
    advanceBy(ms: number) {
      if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isSafeInteger(timeEpochMs + ms)) {
        throw new Error(
          "NODE_RUNTIME_SCENARIO_INVALID_TIME_ADVANCE: expected nonnegative integer milliseconds.",
        );
      }
      timeEpochMs += ms;
    },
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-scenario-"));
  const runtimes: ReturnType<typeof createScenarioObjectRuntime<TFactories>>[] = [];
  try {
    for (const name of runtimeNames) {
      runtimes.push(
        createScenarioObjectRuntime(directory, name, definition.objects, clock.nowEpochMs),
      );
    }
    const objects = runtimes[0].objects;
    const processors = Object.fromEntries(
      definition.processors.map((name, index) => [
        name,
        { tick: () => runtimes[index + 1].tick() },
      ]),
    ) as NodeRuntimeScenarioContext<TFactories, TProcessors>["processors"];
    const context: NodeRuntimeScenarioContext<TFactories, TProcessors> = {
      server: definition.server({ objects, nowEpochMs: clock.nowEpochMs }),
      objects,
      processors,
      clock,
    };
    type Step = ScenarioStep<typeof context>;
    function step(kind: Step["kind"], label: string, run: Step["run"]): Step {
      return { kind, label, run };
    }
    type Steps = ScenarioSteps<typeof context, TProcessors[number]>;
    const builders: Steps = {
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
      processors: Object.fromEntries(
        definition.processors.map((name) => [
          name,
          {
            tick: () =>
              step("processor", `tick ${name}`, async () => {
                await processors[name as TProcessors[number]].tick();
              }),
          },
        ]),
      ) as Steps["processors"],
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
          throwScenarioFailures(branches, "NODE_RUNTIME_SCENARIO_CONCURRENT_STEP_FAILED");
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
      const cleanups = await Promise.allSettled(
        runtimes.map(async (runtime) => {
          await runtime.cleanup();
        }),
      );
      throwScenarioFailures(cleanups, "NODE_RUNTIME_SCENARIO_CLEANUP_FAILED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
