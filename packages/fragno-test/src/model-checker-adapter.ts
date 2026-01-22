import type {
  DatabaseAdapter,
  DatabaseContextStorage,
  TableNameMapper,
} from "@fragno-dev/db/adapters";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "@fragno-dev/db/adapters";
import type { AnySchema } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import type {
  UOWInstrumentation,
  UOWInstrumentationContext,
  UOWInstrumentationInjection,
  UOWInstrumentationFinalizer,
} from "@fragno-dev/db/unit-of-work";
import type { ModelCheckerPhase } from "./model-checker";

type SchedulerHook = (ctx: UOWInstrumentationContext, phase: ModelCheckerPhase) => Promise<void>;

export type ModelCheckerScheduler = {
  beforePhase: SchedulerHook;
  afterPhase: SchedulerHook;
};

const isInstrumentationInjection = (value: unknown): value is UOWInstrumentationInjection => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { type?: string };
  return candidate.type === "conflict" || candidate.type === "error";
};

const mergeHook = (
  primary: UOWInstrumentation[keyof UOWInstrumentation] | undefined,
  secondary: UOWInstrumentation[keyof UOWInstrumentation] | undefined,
  options: { alwaysCallSecondary?: boolean } = {},
): UOWInstrumentation[keyof UOWInstrumentation] | undefined => {
  if (!primary && !secondary) {
    return undefined;
  }

  const hook = async (
    ctx: UOWInstrumentationContext,
  ): Promise<void | UOWInstrumentationInjection> => {
    let result: void | UOWInstrumentationInjection;
    if (options.alwaysCallSecondary) {
      try {
        result = await primary?.(ctx);
      } finally {
        await secondary?.(ctx);
      }
    } else {
      result = await primary?.(ctx);
      if (!isInstrumentationInjection(result)) {
        const secondaryResult = await secondary?.(ctx);
        if (isInstrumentationInjection(secondaryResult)) {
          return secondaryResult;
        }
      }
    }

    if (isInstrumentationInjection(result)) {
      return result;
    }

    return undefined;
  };

  return hook as UOWInstrumentation[keyof UOWInstrumentation];
};

const mergeInstrumentation = (
  existing: UOWInstrumentation | undefined,
  scheduler: ModelCheckerScheduler | null,
): {
  instrumentation?: UOWInstrumentation;
  instrumentationFinalizer?: UOWInstrumentationFinalizer;
} => {
  if (!scheduler) {
    return { instrumentation: existing };
  }

  const schedulerBeforeRetrieve = (ctx: UOWInstrumentationContext) =>
    scheduler.beforePhase(ctx, "retrieve");
  const schedulerAfterRetrieve = (ctx: UOWInstrumentationContext) =>
    scheduler.afterPhase(ctx, "retrieve");
  const schedulerBeforeMutate = (ctx: UOWInstrumentationContext) =>
    scheduler.beforePhase(ctx, "mutate");
  const schedulerAfterMutate = (ctx: UOWInstrumentationContext) =>
    scheduler.afterPhase(ctx, "mutate");

  return {
    instrumentation: {
      beforeRetrieve: mergeHook(schedulerBeforeRetrieve, existing?.beforeRetrieve),
      afterRetrieve: existing?.afterRetrieve,
      beforeMutate: mergeHook(schedulerBeforeMutate, existing?.beforeMutate),
      afterMutate: existing?.afterMutate,
    },
    instrumentationFinalizer: {
      afterRetrieve: schedulerAfterRetrieve,
      afterMutate: schedulerAfterMutate,
    },
  };
};

export class ModelCheckerAdapter<TUowConfig = void> implements DatabaseAdapter<TUowConfig> {
  [fragnoDatabaseAdapterNameFakeSymbol]: string;
  [fragnoDatabaseAdapterVersionFakeSymbol]: number;

  readonly contextStorage: RequestContextStorage<DatabaseContextStorage>;
  prepareMigrations?: DatabaseAdapter<TUowConfig>["prepareMigrations"];
  createSchemaGenerator?: DatabaseAdapter<TUowConfig>["createSchemaGenerator"];

  #baseAdapter: DatabaseAdapter<TUowConfig>;
  #scheduler: ModelCheckerScheduler | null = null;

  constructor(baseAdapter: DatabaseAdapter<TUowConfig>) {
    this.#baseAdapter = baseAdapter;
    this.contextStorage = baseAdapter.contextStorage;
    this[fragnoDatabaseAdapterNameFakeSymbol] = baseAdapter[fragnoDatabaseAdapterNameFakeSymbol];
    this[fragnoDatabaseAdapterVersionFakeSymbol] =
      baseAdapter[fragnoDatabaseAdapterVersionFakeSymbol];
    this.prepareMigrations = baseAdapter.prepareMigrations?.bind(baseAdapter);
    this.createSchemaGenerator = baseAdapter.createSchemaGenerator?.bind(baseAdapter);
  }

  setScheduler(scheduler: ModelCheckerScheduler | null): void {
    this.#scheduler = scheduler;
  }

  getSchemaVersion(namespace: string): Promise<string | undefined> {
    return this.#baseAdapter.getSchemaVersion(namespace);
  }

  createQueryEngine<const T extends AnySchema>(
    schema: T,
    namespace: string,
  ): SimpleQueryInterface<T, TUowConfig> {
    const engine = this.#baseAdapter.createQueryEngine(schema, namespace);

    const wrappedCreateUnitOfWork = (name?: string, config?: TUowConfig) => {
      const scheduler = this.#scheduler;
      if (!scheduler) {
        return engine.createUnitOfWork(name, config);
      }

      const configWithInstrumentation = (() => {
        if (!config || typeof config !== "object") {
          const merged = mergeInstrumentation(undefined, scheduler);
          return merged as TUowConfig;
        }

        const typedConfig = config as {
          instrumentation?: UOWInstrumentation;
          instrumentationFinalizer?: UOWInstrumentationFinalizer;
        };
        const merged = mergeInstrumentation(typedConfig.instrumentation, scheduler);
        return {
          ...typedConfig,
          instrumentation: merged.instrumentation,
          instrumentationFinalizer:
            merged.instrumentationFinalizer ?? typedConfig.instrumentationFinalizer,
        } as TUowConfig;
      })();

      return engine.createUnitOfWork(name, configWithInstrumentation);
    };

    return new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === "createUnitOfWork") {
          return wrappedCreateUnitOfWork;
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return value.bind(target);
        }
        return value;
      },
    });
  }

  createTableNameMapper(namespace: string): TableNameMapper {
    return this.#baseAdapter.createTableNameMapper(namespace);
  }

  isConnectionHealthy(): Promise<boolean> {
    return this.#baseAdapter.isConnectionHealthy();
  }

  close(): Promise<void> {
    return this.#baseAdapter.close();
  }
}
