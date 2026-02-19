import type { FragnoRuntime } from "@fragno-dev/core";
import {
  runWithTraceRecorder,
  type FragnoCoreTraceEvent,
} from "@fragno-dev/core/internal/trace-context";
import { FragnoId, FragnoReference, type AnySchema } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { TypedUnitOfWork } from "@fragno-dev/db";
import type { MutationOperation } from "@fragno-dev/db/unit-of-work";

export type ModelCheckerMode = "exhaustive" | "bounded-exhaustive" | "random" | "infinite";
export type ModelCheckerPhase = "retrieve" | "mutate";

export type ModelCheckerStep = {
  txId: number;
  phase: ModelCheckerPhase;
};

export type ModelCheckerTraceHashMode = "state" | "trace" | "state+trace";

export type NormalizedMutationOperation = {
  type: "create" | "update" | "delete" | "check" | "upsert";
  table: string;
  namespace?: string | null;
  id?: unknown;
  checkVersion?: boolean;
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
  generatedExternalId?: string;
  conflictIndex?: string;
};

export type ModelCheckerTraceEvent =
  | {
      type: "schedule-step";
      step: ModelCheckerStep;
      stepIndex: number;
    }
  | {
      type: "retrieve-output";
      txId?: number;
      uowName?: string;
      output: unknown;
    }
  | {
      type: "mutation-input";
      txId?: number;
      uowName?: string;
      operations: NormalizedMutationOperation[];
    }
  | {
      type: "mutation-result";
      txId?: number;
      uowName?: string;
      success: boolean;
      createdIds: unknown[];
      error?: string;
    }
  | {
      type: "runtime";
      operation: "time.now" | "random.float" | "random.uuid" | "random.cuid";
      value: unknown;
    }
  | {
      type: "external";
      name: string;
      payload: unknown;
    };

export type ModelCheckerTrace = {
  events: ModelCheckerTraceEvent[];
};

export type ModelCheckerTraceRecorder = (event: ModelCheckerTraceEvent) => void;

export type ModelCheckerTraceHasher = (trace: ModelCheckerTrace) => Promise<string> | string;

export type RawUowTransactionContext<TSchema extends AnySchema, TUowConfig> = {
  queryEngine: SimpleQueryInterface<TSchema, TUowConfig>;
  createUnitOfWork: (name?: string, config?: TUowConfig) => TypedUnitOfWork<TSchema, [], unknown>;
  runtime?: FragnoRuntime;
};

export type RawUowMutateContext<
  TSchema extends AnySchema,
  TUowConfig,
  TRetrieve,
> = RawUowTransactionContext<TSchema, TUowConfig> & {
  retrieveResult: TRetrieve;
};

export interface RawUowTransaction<
  TRetrieve = unknown,
  TMutate = unknown,
  TSchema extends AnySchema = AnySchema,
  TUowConfig = void,
> {
  name?: string;
  retrieve(ctx: RawUowTransactionContext<TSchema, TUowConfig>): TRetrieve | Promise<TRetrieve>;
  mutate?(ctx: RawUowMutateContext<TSchema, TUowConfig, TRetrieve>): TMutate | Promise<TMutate>;
}

export type RawUowTransactionBuilder<
  TRetrieve = unknown,
  TMutate = unknown,
  TSchema extends AnySchema = AnySchema,
  TUowConfig = void,
> = {
  name?: string;
  config?: TUowConfig;
  retrieve: (
    uow: TypedUnitOfWork<TSchema, [], unknown>,
    ctx: RawUowTransactionContext<TSchema, TUowConfig>,
  ) => TRetrieve | Promise<TRetrieve>;
  mutate?: (
    uow: TypedUnitOfWork<TSchema, [], unknown>,
    ctx: RawUowMutateContext<TSchema, TUowConfig, TRetrieve>,
  ) => TMutate | Promise<TMutate>;
};

export const createRawUowTransaction = <
  TRetrieve = unknown,
  TMutate = unknown,
  TSchema extends AnySchema = AnySchema,
  TUowConfig = void,
>(
  builder: RawUowTransactionBuilder<TRetrieve, TMutate, TSchema, TUowConfig>,
): RawUowTransaction<TRetrieve, TMutate, TSchema, TUowConfig> => {
  let uow: TypedUnitOfWork<TSchema, [], unknown> | null = null;
  const getUow = (ctx: RawUowTransactionContext<TSchema, TUowConfig>, phase: ModelCheckerPhase) => {
    if (!uow) {
      if (phase === "mutate") {
        throw new Error("Raw UOW mutate invoked before retrieve.");
      }
      uow = ctx.createUnitOfWork(builder.name, builder.config);
    }
    return uow;
  };

  const mutate = builder.mutate;
  return {
    name: builder.name,
    retrieve: (ctx) => builder.retrieve(getUow(ctx, "retrieve"), ctx),
    mutate: mutate ? (ctx) => mutate(getUow(ctx, "mutate"), ctx) : undefined,
  };
};

export type ModelCheckerExecutionContext<TSchema extends AnySchema, TUowConfig> = {
  ctx: RawUowTransactionContext<TSchema, TUowConfig>;
  cleanup?: () => Promise<void>;
};

export type ModelCheckerHistory =
  | false
  | { type: "lru"; maxEntries: number }
  | { type: "unbounded" };

export type ModelCheckerBounds = {
  maxSteps?: number;
};

export type ModelCheckerStateHasherContext<TSchema extends AnySchema, TUowConfig> = {
  schema: TSchema;
  queryEngine: SimpleQueryInterface<TSchema, TUowConfig>;
};

export type ModelCheckerConfig<TSchema extends AnySchema, TUowConfig = void> = {
  schema: TSchema;
  mode?: ModelCheckerMode;
  seed?: number;
  maxSchedules?: number;
  bounds?: ModelCheckerBounds;
  history?: ModelCheckerHistory;
  stopWhenFrontierExhausted?: boolean;
  stateHasher?: (ctx: ModelCheckerStateHasherContext<TSchema, TUowConfig>) => Promise<string>;
  traceRecorder?: ModelCheckerTraceRecorder;
  traceHasher?: ModelCheckerTraceHasher;
  traceHashMode?: ModelCheckerTraceHashMode;
  runtime?: FragnoRuntime;
  createContext: () => Promise<ModelCheckerExecutionContext<TSchema, TUowConfig>>;
  setup?: (ctx: RawUowTransactionContext<TSchema, TUowConfig>) => Promise<void>;
  buildTransactions: (
    ctx: RawUowTransactionContext<TSchema, TUowConfig>,
  ) => RawUowTransaction<unknown, unknown, TSchema, TUowConfig>[];
};

export type ModelCheckerScheduleResult = {
  schedule: ModelCheckerStep[];
  stateHash: string;
  traceHash?: string;
  trace?: ModelCheckerTrace;
};

export type ModelCheckerRunResult = {
  schedules: ModelCheckerScheduleResult[];
  visitedPaths: number;
};

type HistoryTracker = {
  add: (key: string) => boolean;
  size: () => number;
};

type TransactionPlan = {
  stepsPerTransaction: number[];
};

type ScheduleExecutionResult = {
  stateHash: string;
  newPathsAdded: boolean;
  traceHash?: string;
  trace?: ModelCheckerTrace;
};

const defaultHistoryConfig: ModelCheckerHistory = { type: "lru", maxEntries: 5000 };

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 1831565813;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const serializeSchedulePrefix = (schedule: ModelCheckerStep[]): string =>
  schedule.map((step) => `${step.txId}:${step.phase}`).join("|");

const buildPathKey = (pathHash: string, prefix: ModelCheckerStep[]): string =>
  `${pathHash}::${serializeSchedulePrefix(prefix)}`;

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
        if (first !== undefined) {
          map.delete(first);
        }
      }
      return !existed;
    },
    size: () => map.size,
  };
};

const normalizeForHash = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof FragnoId) {
    return {
      externalId: value.externalId,
      internalId: value.internalId?.toString(),
      version: value.version,
    };
  }

  if (value instanceof FragnoReference) {
    return value.internalId.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForHash(entry));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const normalized: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      normalized[key] = normalizeForHash(record[key]);
    }
    return normalized;
  }

  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(normalizeForHash(value));

export const defaultStateHasher = async <TSchema extends AnySchema, TUowConfig>(
  ctx: ModelCheckerStateHasherContext<TSchema, TUowConfig>,
): Promise<string> => {
  const tableNames = Object.keys(ctx.schema.tables).sort();
  const snapshot: { table: string; rows: unknown[] }[] = [];

  for (const tableName of tableNames) {
    const rows = await ctx.queryEngine.find(tableName, (b) =>
      b.whereIndex("primary").orderByIndex("primary", "asc"),
    );
    snapshot.push({ table: tableName, rows });
  }

  return stableStringify(snapshot);
};

export const defaultTraceHasher = async (trace: ModelCheckerTrace): Promise<string> =>
  stableStringify(trace.events);

const resolvePathHash = (
  stateHash: string,
  traceHash: string | undefined,
  mode: ModelCheckerTraceHashMode,
): string => {
  if (mode === "state") {
    return stateHash;
  }
  if (!traceHash) {
    throw new Error("Trace hash mode requires traceHasher to be configured.");
  }
  if (mode === "trace") {
    return traceHash;
  }
  return `${stateHash}::${traceHash}`;
};

const wrapRuntimeForTrace = (
  runtime: FragnoRuntime,
  record: (event: ModelCheckerTraceEvent) => void,
): FragnoRuntime => ({
  time: {
    now: () => {
      const value = runtime.time.now();
      record({ type: "runtime", operation: "time.now", value });
      return value;
    },
  },
  random: {
    float: () => {
      const value = runtime.random.float();
      record({ type: "runtime", operation: "random.float", value });
      return value;
    },
    uuid: () => {
      const value = runtime.random.uuid();
      record({ type: "runtime", operation: "random.uuid", value });
      return value;
    },
    cuid: () => {
      const value = runtime.random.cuid();
      record({ type: "runtime", operation: "random.cuid", value });
      return value;
    },
  },
});

const captureCoreTrace = (
  record: (event: ModelCheckerTraceEvent) => void,
  event: FragnoCoreTraceEvent,
) => {
  record({ type: "external", name: event.type, payload: event });
};

const createTraceContext = (
  recorder: ModelCheckerTraceRecorder | undefined,
  traceHasher: ModelCheckerTraceHasher | undefined,
) => {
  const events = recorder || traceHasher ? ([] as ModelCheckerTraceEvent[]) : null;
  const record = (event: ModelCheckerTraceEvent) => {
    if (events) {
      events.push(event);
    }
    recorder?.(event);
  };

  return { events, record };
};

const normalizeMutationOperation = (
  op: MutationOperation<AnySchema>,
): NormalizedMutationOperation => {
  if (op.type === "create") {
    return {
      type: "create",
      table: op.table,
      namespace: op.namespace,
      values: normalizeForHash(op.values) as Record<string, unknown>,
      generatedExternalId: op.generatedExternalId,
    };
  }

  if (op.type === "update") {
    return {
      type: "update",
      table: op.table,
      namespace: op.namespace,
      id: normalizeForHash(op.id),
      checkVersion: op.checkVersion,
      set: normalizeForHash(op.set) as Record<string, unknown>,
    };
  }

  if (op.type === "upsert") {
    return {
      type: "upsert",
      table: op.table,
      namespace: op.namespace,
      values: normalizeForHash(op.values) as Record<string, unknown>,
      generatedExternalId: op.generatedExternalId,
      conflictIndex: op.conflictIndex,
    };
  }

  if (op.type === "delete") {
    return {
      type: "delete",
      table: op.table,
      namespace: op.namespace,
      id: normalizeForHash(op.id),
      checkVersion: op.checkVersion,
    };
  }

  return {
    type: "check",
    table: op.table,
    namespace: op.namespace,
    id: normalizeForHash(op.id),
  };
};

const wrapCreateUnitOfWorkForTrace = <TSchema extends AnySchema, TUowConfig>(
  createUnitOfWork: (name?: string, config?: TUowConfig) => TypedUnitOfWork<TSchema, [], unknown>,
  getTxId: () => number | undefined,
  record: (event: ModelCheckerTraceEvent) => void,
) => {
  return (name?: string, config?: TUowConfig) => {
    const uow = createUnitOfWork(name, config);
    return new Proxy(uow, {
      get(target, prop, receiver) {
        if (prop === "executeRetrieve") {
          return async () => {
            const result = await target.executeRetrieve();
            record({
              type: "retrieve-output",
              txId: getTxId(),
              uowName: target.name,
              output: normalizeForHash(result),
            });
            return result;
          };
        }

        if (prop === "executeMutations") {
          return async () => {
            const txId = getTxId();
            record({
              type: "mutation-input",
              txId,
              uowName: target.name,
              operations: target.getMutationOperations().map(normalizeMutationOperation),
            });
            try {
              const result = await target.executeMutations();
              record({
                type: "mutation-result",
                txId,
                uowName: target.name,
                success: result.success,
                createdIds: result.success ? target.getCreatedIds().map(normalizeForHash) : [],
              });
              return result;
            } catch (error) {
              record({
                type: "mutation-result",
                txId,
                uowName: target.name,
                success: false,
                createdIds: [],
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          };
        }

        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return value.bind(target);
        }
        return value;
      },
    });
  };
};

const planTransactions = <TSchema extends AnySchema, TUowConfig>(
  transactions: RawUowTransaction<unknown, unknown, TSchema, TUowConfig>[],
): TransactionPlan => {
  if (transactions.length === 0) {
    throw new Error("Model checker requires at least one transaction.");
  }

  const stepsPerTransaction = transactions.map((tx) => {
    if (!tx.retrieve) {
      throw new Error("Model checker transactions must define a retrieve step.");
    }
    return tx.mutate ? 2 : 1;
  });

  return { stepsPerTransaction };
};

const generateAllSchedules = (stepsPerTransaction: number[]): ModelCheckerStep[][] => {
  const schedules: ModelCheckerStep[][] = [];
  const totalSteps = stepsPerTransaction.reduce((sum, steps) => sum + steps, 0);
  const progress = stepsPerTransaction.map(() => 0);
  const current: ModelCheckerStep[] = [];

  const walk = () => {
    if (current.length === totalSteps) {
      schedules.push([...current]);
      return;
    }

    for (let txId = 0; txId < stepsPerTransaction.length; txId += 1) {
      if (progress[txId] >= stepsPerTransaction[txId]) {
        continue;
      }
      const phase: ModelCheckerPhase = progress[txId] === 0 ? "retrieve" : "mutate";
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

const generateRandomSchedule = (
  stepsPerTransaction: number[],
  rng: () => number,
): ModelCheckerStep[] => {
  const totalSteps = stepsPerTransaction.reduce((sum, steps) => sum + steps, 0);
  const progress = stepsPerTransaction.map(() => 0);
  const schedule: ModelCheckerStep[] = [];

  for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
    const candidates: number[] = [];
    for (let txId = 0; txId < stepsPerTransaction.length; txId += 1) {
      if (progress[txId] < stepsPerTransaction[txId]) {
        candidates.push(txId);
      }
    }
    const pick = candidates[Math.floor(rng() * candidates.length)];
    const phase: ModelCheckerPhase = progress[pick] === 0 ? "retrieve" : "mutate";
    schedule.push({ txId: pick, phase });
    progress[pick] += 1;
  }

  return schedule;
};

const executeSchedule = async <TSchema extends AnySchema, TUowConfig>(
  schedule: ModelCheckerStep[],
  config: ModelCheckerConfig<TSchema, TUowConfig>,
  history: HistoryTracker | null,
  stateHasher: (ctx: ModelCheckerStateHasherContext<TSchema, TUowConfig>) => Promise<string>,
): Promise<ScheduleExecutionResult> => {
  const traceHashMode = config.traceHashMode ?? "state";
  const traceHasher =
    config.traceHasher ?? (traceHashMode === "state" ? undefined : defaultTraceHasher);
  const traceContext = createTraceContext(config.traceRecorder, traceHasher);
  const traceEnabled = Boolean(traceContext.events);
  const runtime =
    config.runtime && traceEnabled
      ? wrapRuntimeForTrace(config.runtime, traceContext.record)
      : config.runtime;

  const { ctx, cleanup } = await config.createContext();
  try {
    let currentTxId: number | undefined;
    const tracedContext = traceEnabled
      ? {
          ...ctx,
          createUnitOfWork: wrapCreateUnitOfWorkForTrace(
            ctx.createUnitOfWork,
            () => currentTxId,
            traceContext.record,
          ),
          runtime,
        }
      : { ...ctx, runtime };

    if (config.setup) {
      await config.setup(tracedContext);
    }

    const transactions = config.buildTransactions(tracedContext);
    const transactionState = transactions.map(() => ({ retrieveResult: undefined as unknown }));
    let lastStateHash: string | null = null;
    let newPathsAdded = false;

    const runSchedule = async () => {
      for (let stepIndex = 0; stepIndex < schedule.length; stepIndex += 1) {
        const step = schedule[stepIndex];
        if (!step) {
          throw new Error("Schedule step is missing.");
        }
        const tx = transactions[step.txId];
        if (!tx) {
          throw new Error(`Transaction ${step.txId} is missing.`);
        }

        currentTxId = step.txId;
        if (traceEnabled) {
          traceContext.record({ type: "schedule-step", step, stepIndex });
        }

        if (step.phase === "retrieve") {
          transactionState[step.txId].retrieveResult = await tx.retrieve(tracedContext);
        } else {
          if (!tx.mutate) {
            throw new Error(`Transaction ${step.txId} does not define a mutate step.`);
          }
          await tx.mutate({
            ...tracedContext,
            retrieveResult: transactionState[step.txId].retrieveResult,
          });
        }

        if (history) {
          lastStateHash = await stateHasher({
            schema: config.schema,
            queryEngine: tracedContext.queryEngine,
          });
          const traceHash = traceHasher
            ? await traceHasher({ events: traceContext.events ?? [] })
            : undefined;
          const prefix = schedule.slice(0, stepIndex + 1);
          const added = history.add(
            buildPathKey(resolvePathHash(lastStateHash, traceHash, traceHashMode), prefix),
          );
          if (added) {
            newPathsAdded = true;
          }
        }
      }

      currentTxId = undefined;

      if (!lastStateHash) {
        lastStateHash = await stateHasher({
          schema: config.schema,
          queryEngine: tracedContext.queryEngine,
        });
      }

      const finalTraceHash = traceHasher
        ? await traceHasher({ events: traceContext.events ?? [] })
        : undefined;

      return {
        stateHash: lastStateHash,
        newPathsAdded,
        traceHash: finalTraceHash,
        trace: traceContext.events ? { events: traceContext.events } : undefined,
      };
    };

    if (traceEnabled) {
      return await runWithTraceRecorder(
        (event) => captureCoreTrace(traceContext.record, event),
        runSchedule,
      );
    }

    return await runSchedule();
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
};

const getTransactionPlan = async <TSchema extends AnySchema, TUowConfig>(
  config: ModelCheckerConfig<TSchema, TUowConfig>,
): Promise<TransactionPlan> => {
  const { ctx, cleanup } = await config.createContext();
  try {
    const context = config.runtime ? { ...ctx, runtime: config.runtime } : ctx;
    if (config.setup) {
      await config.setup(context);
    }
    const transactions = config.buildTransactions(context);
    return planTransactions(transactions);
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
};

export const runModelChecker = async <TSchema extends AnySchema, TUowConfig>(
  config: ModelCheckerConfig<TSchema, TUowConfig>,
): Promise<ModelCheckerRunResult> => {
  const mode = config.mode ?? "exhaustive";
  const historyConfig = config.history ?? defaultHistoryConfig;
  const history = createHistoryTracker(historyConfig);
  const stateHasher = config.stateHasher ?? defaultStateHasher;
  const { stepsPerTransaction } = await getTransactionPlan(config);
  const schedules: ModelCheckerScheduleResult[] = [];
  const maxSchedules = config.maxSchedules;
  const seed = config.seed ?? 1;

  if (mode === "exhaustive" || mode === "bounded-exhaustive") {
    if (mode === "bounded-exhaustive") {
      const bounds = config.bounds;
      if (bounds?.maxSteps !== undefined) {
        const totalSteps = stepsPerTransaction.reduce((sum, steps) => sum + steps, 0);
        if (totalSteps > bounds.maxSteps) {
          throw new Error(
            `bounded-exhaustive requires maxSteps >= ${totalSteps}, ` +
              `but received ${bounds.maxSteps}`,
          );
        }
      }
    }
    const allSchedules = generateAllSchedules(stepsPerTransaction);
    for (const schedule of allSchedules) {
      if (maxSchedules !== undefined && schedules.length >= maxSchedules) {
        break;
      }
      const result = await executeSchedule(schedule, config, history, stateHasher);
      schedules.push({
        schedule,
        stateHash: result.stateHash,
        traceHash: result.traceHash,
        trace: result.trace,
      });
    }
  } else if (mode === "random") {
    const rng = mulberry32(seed);
    const total = maxSchedules ?? 1;
    for (let i = 0; i < total; i += 1) {
      const schedule = generateRandomSchedule(stepsPerTransaction, rng);
      const result = await executeSchedule(schedule, config, history, stateHasher);
      schedules.push({
        schedule,
        stateHash: result.stateHash,
        traceHash: result.traceHash,
        trace: result.trace,
      });
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
      const schedule = generateRandomSchedule(stepsPerTransaction, rng);
      const result = await executeSchedule(schedule, config, history, stateHasher);
      schedules.push({
        schedule,
        stateHash: result.stateHash,
        traceHash: result.traceHash,
        trace: result.trace,
      });
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
