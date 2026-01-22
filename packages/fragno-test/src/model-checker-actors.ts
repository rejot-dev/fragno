import type { AnySchema } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { UOWInstrumentationContext } from "@fragno-dev/db/unit-of-work";
import {
  defaultStateHasher,
  type ModelCheckerBounds,
  type ModelCheckerHistory,
  type ModelCheckerMode,
  type ModelCheckerPhase,
  type ModelCheckerRunResult,
  type ModelCheckerScheduleResult,
  type ModelCheckerStateHasherContext,
  type ModelCheckerStep,
} from "./model-checker";
import { ModelCheckerAdapter, type ModelCheckerScheduler } from "./model-checker-adapter";

type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const createDeferred = <T>(): DeferredPromise<T> => {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
};

type PendingGate = {
  uowId: number;
  phase: ModelCheckerPhase;
  release: () => void;
  completion: Promise<void>;
};

type UowPlan = {
  hasRetrieve: boolean;
  hasMutate: boolean;
};

type SchedulePlan = {
  phasesPerTransaction: ModelCheckerPhase[][];
};

type SchedulerMode = "record" | "schedule";

class PhaseScheduler implements ModelCheckerScheduler {
  #mode: SchedulerMode;
  #plan: SchedulePlan | null;
  #uowIds = new WeakMap<object, number>();
  #uowPlans: UowPlan[] = [];
  #pending: PendingGate[] = [];
  #pendingSignal = createDeferred<void>();
  #inFlight = new Map<string, DeferredPromise<void>>();
  #actorsDone = false;

  constructor(mode: SchedulerMode, plan?: SchedulePlan) {
    this.#mode = mode;
    this.#plan = plan ?? null;
  }

  markActorsDone(): void {
    this.#actorsDone = true;
    this.#pendingSignal.resolve();
  }

  getPlan(): SchedulePlan {
    return {
      phasesPerTransaction: this.#uowPlans.map((entry) => {
        const phases: ModelCheckerPhase[] = [];
        if (entry.hasRetrieve) {
          phases.push("retrieve");
        }
        if (entry.hasMutate) {
          phases.push("mutate");
        }
        return phases;
      }),
    };
  }

  async beforePhase(ctx: UOWInstrumentationContext, phase: ModelCheckerPhase): Promise<void> {
    const uow = ctx.uow as object;
    const uowId = this.#getOrCreateUowId(uow);

    if (phase === "mutate") {
      const plan = this.#uowPlans[uowId];
      if (plan) {
        plan.hasMutate = true;
      }
    } else {
      const plan = this.#uowPlans[uowId];
      if (plan) {
        plan.hasRetrieve = true;
      }
    }

    if (this.#mode === "record") {
      return;
    }

    this.#assertPlanned(uowId, phase);
    const release = createDeferred<void>();
    const completion = createDeferred<void>();
    this.#inFlight.set(`${uowId}:${phase}`, completion);
    const gate: PendingGate = {
      uowId,
      phase,
      release: () => {
        release.resolve();
      },
      completion: completion.promise,
    };
    this.#pending.push(gate);
    this.#pendingSignal.resolve();
    this.#pendingSignal = createDeferred<void>();
    await release.promise;
  }

  async afterPhase(ctx: UOWInstrumentationContext, phase: ModelCheckerPhase): Promise<void> {
    const uow = ctx.uow as object;
    const uowId = this.#getOrCreateUowId(uow);
    const key = `${uowId}:${phase}`;
    const completion = this.#inFlight.get(key);
    if (completion) {
      completion.resolve();
      this.#inFlight.delete(key);
    }
  }

  async releaseStep(step: ModelCheckerStep, actorsPromise: Promise<void>): Promise<void> {
    for (;;) {
      const matchIndex = this.#pending.findIndex(
        (gate) => gate.uowId === step.txId && gate.phase === step.phase,
      );
      if (matchIndex !== -1) {
        const [gate] = this.#pending.splice(matchIndex, 1);
        gate.release();
        await gate.completion;
        return;
      }

      if (this.#pending.length > 0) {
        const pendingSummary = this.#pending
          .map((gate) => `${gate.uowId}:${gate.phase}`)
          .join(", ");
        throw new Error(
          `Model checker schedule mismatch. Expected ${step.txId}:${step.phase}, pending [${pendingSummary}]`,
        );
      }

      await Promise.race([this.#pendingSignal.promise, actorsPromise]);
      if (this.#actorsDone) {
        throw new Error(
          `Model checker schedule expects ${step.phase} for UOW ${step.txId}, but no gate appeared.`,
        );
      }
    }
  }

  async releaseAny(
    pickIndex: (pending: PendingGate[]) => number,
    actorsPromise: Promise<void>,
  ): Promise<ModelCheckerStep | null> {
    for (;;) {
      if (this.#pending.length > 0) {
        const index = Math.max(0, Math.min(pickIndex(this.#pending), this.#pending.length - 1));
        const [gate] = this.#pending.splice(index, 1);
        gate.release();
        await gate.completion;
        return { txId: gate.uowId, phase: gate.phase };
      }

      await Promise.race([this.#pendingSignal.promise, actorsPromise]);
      if (this.#actorsDone) {
        return null;
      }
    }
  }

  #getOrCreateUowId(uow: object): number {
    const existing = this.#uowIds.get(uow);
    if (existing !== undefined) {
      return existing;
    }

    const next = this.#uowPlans.length;
    if (this.#plan && next >= this.#plan.phasesPerTransaction.length) {
      throw new Error("Model checker saw more UOWs than planned.");
    }

    this.#uowIds.set(uow, next);
    this.#uowPlans.push({ hasRetrieve: false, hasMutate: false });
    return next;
  }

  #assertPlanned(uowId: number, phase: ModelCheckerPhase): void {
    const plan = this.#plan;
    if (!plan) {
      return;
    }

    const phases = plan.phasesPerTransaction[uowId];
    if (!phases || phases.length === 0) {
      throw new Error(`Model checker saw unexpected UOW ${uowId}.`);
    }

    if (!phases.includes(phase)) {
      throw new Error(`Model checker saw unexpected ${phase} phase for UOW ${uowId}.`);
    }
  }
}

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 1831565813;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const generateAllSchedules = (
  phasesPerTransaction: ModelCheckerPhase[][],
): ModelCheckerStep[][] => {
  const schedules: ModelCheckerStep[][] = [];
  const totalSteps = phasesPerTransaction.reduce((sum, phases) => sum + phases.length, 0);
  const progress = phasesPerTransaction.map(() => 0);
  const current: ModelCheckerStep[] = [];

  const walk = () => {
    if (current.length === totalSteps) {
      schedules.push([...current]);
      return;
    }

    for (let txId = 0; txId < phasesPerTransaction.length; txId += 1) {
      if (progress[txId] >= phasesPerTransaction[txId].length) {
        continue;
      }
      const phase = phasesPerTransaction[txId][progress[txId]];
      if (!phase) {
        continue;
      }
      current.push({ txId, phase });
      progress[txId] += 1;
      walk();
      progress[txId] -= 1;
      current.pop();
    }
  };

  walk();
  return schedules;
};

type HistoryTracker = {
  add: (key: string) => boolean;
  size: () => number;
};

const createHistoryTracker = (history: ModelCheckerHistory): HistoryTracker | null => {
  if (!history) {
    return null;
  }

  if (history.type === "unbounded") {
    const set = new Set<string>();
    return {
      add: (key: string) => {
        const has = set.has(key);
        if (!has) {
          set.add(key);
        }
        return !has;
      },
      size: () => set.size,
    };
  }

  const maxEntries = Math.max(history.maxEntries, 1);
  const map = new Map<string, true>();
  return {
    add: (key: string) => {
      const existed = map.delete(key);
      map.set(key, true);
      if (map.size > maxEntries) {
        const first = map.keys().next().value;
        if (first) {
          map.delete(first);
        }
      }
      return !existed;
    },
    size: () => map.size,
  };
};

const serializeSchedulePrefix = (schedule: ModelCheckerStep[]): string =>
  schedule.map((step) => `${step.txId}:${step.phase}`).join("|");

const buildPathKey = (stateHash: string, prefix: ModelCheckerStep[]): string =>
  `${stateHash}::${serializeSchedulePrefix(prefix)}`;

export type ModelCheckerActor<TContext> = {
  name?: string;
  run: (ctx: TContext) => Promise<void> | void;
};

export type ModelCheckerInvariantContext<TSchema extends AnySchema, TUowConfig, TContext> = {
  schema: TSchema;
  queryEngine: SimpleQueryInterface<TSchema, TUowConfig>;
  context: TContext;
  schedule: ModelCheckerStep[];
  stepIndex: number;
};

export type ModelCheckerInvariant<TSchema extends AnySchema, TUowConfig, TContext> = (
  ctx: ModelCheckerInvariantContext<TSchema, TUowConfig, TContext>,
) => Promise<void> | void;

export type ModelCheckerActorsConfig<TSchema extends AnySchema, TUowConfig, TContext> = {
  schema: TSchema;
  mode?: ModelCheckerMode;
  seed?: number;
  maxSchedules?: number;
  bounds?: ModelCheckerBounds;
  history?: ModelCheckerHistory;
  stopWhenFrontierExhausted?: boolean;
  stateHasher?: (ctx: ModelCheckerStateHasherContext<TSchema, TUowConfig>) => Promise<string>;
  createContext: () => Promise<{
    adapter: ModelCheckerAdapter<TUowConfig>;
    ctx: TContext;
    queryEngine: SimpleQueryInterface<TSchema, TUowConfig>;
    cleanup?: () => Promise<void>;
  }>;
  setup?: (ctx: TContext) => Promise<void>;
  buildActors: (ctx: TContext) => ModelCheckerActor<TContext>[];
  invariants?: ModelCheckerInvariant<TSchema, TUowConfig, TContext>[];
};

const defaultHistoryConfig: ModelCheckerHistory = { type: "lru", maxEntries: 5000 };

const planTransactions = (phasesPerTransaction: ModelCheckerPhase[][]): SchedulePlan => {
  if (phasesPerTransaction.length === 0) {
    throw new Error("Model checker requires at least one transaction.");
  }
  return { phasesPerTransaction };
};

const recordPlan = async <TSchema extends AnySchema, TUowConfig, TContext>(
  config: ModelCheckerActorsConfig<TSchema, TUowConfig, TContext>,
): Promise<SchedulePlan> => {
  const { adapter, ctx, cleanup } = await config.createContext();

  try {
    if (config.setup) {
      await config.setup(ctx);
    }
    const scheduler = new PhaseScheduler("record");
    adapter.setScheduler(scheduler);
    const actors = config.buildActors(ctx);
    await Promise.all(actors.map((actor) => actor.run(ctx)));
    return planTransactions(scheduler.getPlan().phasesPerTransaction);
  } finally {
    adapter.setScheduler(null);
    if (cleanup) {
      await cleanup();
    }
  }
};

const executeSchedule = async <TSchema extends AnySchema, TUowConfig, TContext>(
  schedule: ModelCheckerStep[],
  config: ModelCheckerActorsConfig<TSchema, TUowConfig, TContext>,
  plan: SchedulePlan,
  history: HistoryTracker | null,
  stateHasher: (ctx: ModelCheckerStateHasherContext<TSchema, TUowConfig>) => Promise<string>,
): Promise<{ stateHash: string; newPathsAdded: boolean }> => {
  const { adapter, ctx, queryEngine, cleanup } = await config.createContext();

  try {
    if (config.setup) {
      await config.setup(ctx);
    }
    const scheduler = new PhaseScheduler("schedule", plan);
    adapter.setScheduler(scheduler);

    const actors = config.buildActors(ctx);
    const actorsPromise = Promise.all(actors.map((actor) => actor.run(ctx))).then(() => {
      scheduler.markActorsDone();
    });

    let lastStateHash: string | null = null;
    let newPathsAdded = false;

    for (let stepIndex = 0; stepIndex < schedule.length; stepIndex += 1) {
      const step = schedule[stepIndex];
      if (!step) {
        throw new Error("Schedule step is missing.");
      }

      await scheduler.releaseStep(step, actorsPromise);

      if (config.invariants) {
        for (const invariant of config.invariants) {
          await invariant({
            schema: config.schema,
            queryEngine,
            context: ctx,
            schedule,
            stepIndex,
          });
        }
      }

      if (history) {
        lastStateHash = await stateHasher({
          schema: config.schema,
          queryEngine,
        });
        const prefix = schedule.slice(0, stepIndex + 1);
        const added = history.add(buildPathKey(lastStateHash, prefix));
        if (added) {
          newPathsAdded = true;
        }
      }
    }

    await actorsPromise;

    if (!lastStateHash) {
      lastStateHash = await stateHasher({ schema: config.schema, queryEngine });
    }

    return { stateHash: lastStateHash, newPathsAdded };
  } finally {
    adapter.setScheduler(null);
    if (cleanup) {
      await cleanup();
    }
  }
};

const executeScheduleDynamic = async <TSchema extends AnySchema, TUowConfig, TContext>(
  config: ModelCheckerActorsConfig<TSchema, TUowConfig, TContext>,
  history: HistoryTracker | null,
  stateHasher: (ctx: ModelCheckerStateHasherContext<TSchema, TUowConfig>) => Promise<string>,
  pickIndex: (pending: PendingGate[]) => number,
): Promise<{ schedule: ModelCheckerStep[]; stateHash: string; newPathsAdded: boolean }> => {
  const { adapter, ctx, queryEngine, cleanup } = await config.createContext();

  try {
    if (config.setup) {
      await config.setup(ctx);
    }

    const scheduler = new PhaseScheduler("schedule");
    adapter.setScheduler(scheduler);

    const actors = config.buildActors(ctx);
    const actorsPromise = Promise.all(actors.map((actor) => actor.run(ctx))).then(() => {
      scheduler.markActorsDone();
    });

    const schedule: ModelCheckerStep[] = [];
    let lastStateHash: string | null = null;
    let newPathsAdded = false;

    for (;;) {
      const step = await scheduler.releaseAny(pickIndex, actorsPromise);
      if (!step) {
        break;
      }

      schedule.push(step);
      const stepIndex = schedule.length - 1;

      if (config.invariants) {
        for (const invariant of config.invariants) {
          await invariant({
            schema: config.schema,
            queryEngine,
            context: ctx,
            schedule,
            stepIndex,
          });
        }
      }

      if (history) {
        lastStateHash = await stateHasher({
          schema: config.schema,
          queryEngine,
        });
        const prefix = schedule.slice(0, stepIndex + 1);
        const added = history.add(buildPathKey(lastStateHash, prefix));
        if (added) {
          newPathsAdded = true;
        }
      }
    }

    await actorsPromise;

    if (!lastStateHash) {
      lastStateHash = await stateHasher({ schema: config.schema, queryEngine });
    }

    return { schedule, stateHash: lastStateHash, newPathsAdded };
  } finally {
    adapter.setScheduler(null);
    if (cleanup) {
      await cleanup();
    }
  }
};

const executeScheduleDynamicWithChoices = async <TSchema extends AnySchema, TUowConfig, TContext>(
  config: ModelCheckerActorsConfig<TSchema, TUowConfig, TContext>,
  history: HistoryTracker | null,
  stateHasher: (ctx: ModelCheckerStateHasherContext<TSchema, TUowConfig>) => Promise<string>,
  choices: number[],
): Promise<{
  schedule: ModelCheckerStep[];
  stateHash: string;
  newPathsAdded: boolean;
  choicePoints: number[];
}> => {
  const choicePoints: number[] = [];
  const result = await executeScheduleDynamic(config, history, stateHasher, (pending) => {
    const stepIndex = choicePoints.length;
    choicePoints.push(pending.length);
    const choice = choices[stepIndex];
    if (choice === undefined || choice < 0 || choice >= pending.length) {
      return 0;
    }
    return choice;
  });

  return {
    ...result,
    choicePoints,
  };
};

const serializeChoices = (choices: number[]): string => choices.join(",");

export const runModelCheckerWithActors = async <TSchema extends AnySchema, TUowConfig, TContext>(
  config: ModelCheckerActorsConfig<TSchema, TUowConfig, TContext>,
): Promise<ModelCheckerRunResult> => {
  const mode = config.mode ?? "exhaustive";
  const historyConfig = config.history ?? defaultHistoryConfig;
  const history = createHistoryTracker(historyConfig);
  const stateHasher = config.stateHasher ?? defaultStateHasher;
  const schedules: ModelCheckerScheduleResult[] = [];
  const maxSchedules = config.maxSchedules;
  const seed = config.seed ?? 1;

  if (mode === "exhaustive") {
    const plan = await recordPlan(config);
    const allSchedules = generateAllSchedules(plan.phasesPerTransaction);
    for (const schedule of allSchedules) {
      if (maxSchedules !== undefined && schedules.length >= maxSchedules) {
        break;
      }
      const result = await executeSchedule(schedule, config, plan, history, stateHasher);
      schedules.push({ schedule, stateHash: result.stateHash });
    }
  } else if (mode === "bounded-exhaustive") {
    const maxSteps = config.bounds?.maxSteps;
    if (!maxSteps || maxSteps < 1) {
      throw new Error("bounded-exhaustive mode requires bounds.maxSteps >= 1.");
    }

    const stack: number[][] = [[]];
    const seen = new Set<string>();
    seen.add("");

    while (stack.length > 0) {
      if (maxSchedules !== undefined && schedules.length >= maxSchedules) {
        break;
      }

      const choices = stack.pop();
      if (!choices) {
        break;
      }

      const result = await executeScheduleDynamicWithChoices(config, history, stateHasher, choices);
      schedules.push({ schedule: result.schedule, stateHash: result.stateHash });

      const limit = Math.min(result.choicePoints.length, maxSteps);
      for (let stepIndex = 0; stepIndex < limit; stepIndex += 1) {
        const count = result.choicePoints[stepIndex];
        const current = choices[stepIndex] ?? 0;
        for (let alt = current + 1; alt < count; alt += 1) {
          const next = choices.slice(0, stepIndex);
          next[stepIndex] = alt;
          const key = serializeChoices(next);
          if (!seen.has(key)) {
            seen.add(key);
            stack.push(next);
          }
        }
      }
    }
  } else if (mode === "random") {
    const rng = mulberry32(seed);
    const total = maxSchedules ?? 1;
    for (let i = 0; i < total; i += 1) {
      const result = await executeScheduleDynamic(config, history, stateHasher, (pending) =>
        Math.floor(rng() * pending.length),
      );
      schedules.push({ schedule: result.schedule, stateHash: result.stateHash });
    }
  } else {
    const rng = mulberry32(seed);
    const stopWhenFrontierExhausted = config.stopWhenFrontierExhausted ?? false;
    let iterations = 0;
    let frontierExhausted = false;

    while (!frontierExhausted) {
      if (maxSchedules !== undefined && iterations >= maxSchedules) {
        break;
      }
      const result = await executeScheduleDynamic(config, history, stateHasher, (pending) =>
        Math.floor(rng() * pending.length),
      );
      schedules.push({ schedule: result.schedule, stateHash: result.stateHash });
      iterations += 1;

      if (stopWhenFrontierExhausted && history) {
        frontierExhausted = !result.newPathsAdded;
      }
    }
  }

  return {
    schedules,
    visitedPaths: history?.size() ?? 0,
  };
};
