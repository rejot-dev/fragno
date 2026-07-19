import type { AnySchema } from "@fragno-dev/db/schema";

import type {
  LofiQueryFindFirstResult,
  LofiQueryFindResult,
  LofiQueryFindWithCursorResult,
} from "../query-types";
import type { LofiFindBuilder } from "../query/read-plan";
import type { LofiQueryEngineOptions, LofiQueryableAdapter } from "../types";

const lofiRuntimeTxBuilderBrand = Symbol("lofi.runtime.tx.builder");
const lofiRuntimeTxQueryBrand = Symbol("lofi.runtime.tx.query");

type LofiRuntimeTxQuery<TResult> = {
  readonly [lofiRuntimeTxQueryBrand]: true;
  execute: () => Promise<TResult>;
};

export type LofiRuntimeTxResolved<T> =
  T extends LofiRuntimeTxQuery<infer TResult>
    ? TResult
    : T extends readonly [infer THead, ...infer TTail]
      ? readonly [LofiRuntimeTxResolved<THead>, ...LofiRuntimeTxResolved<TTail>]
      : T extends readonly (infer TItem)[]
        ? LofiRuntimeTxResolved<TItem>[]
        : T extends object
          ? { [K in keyof T]: LofiRuntimeTxResolved<T[K]> }
          : T;

export type LofiRuntimeTxSchemaRead<TSchema extends AnySchema> = {
  find: <TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TTableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  ) => LofiRuntimeTxQuery<LofiQueryFindResult<TSchema["tables"][TTableName], TBuilderResult>>;

  findFirst: <TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TTableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  ) => LofiRuntimeTxQuery<LofiQueryFindFirstResult<TSchema["tables"][TTableName], TBuilderResult>>;

  findWithCursor: <TTableName extends keyof TSchema["tables"] & string, const TBuilderResult>(
    table: TTableName,
    builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => TBuilderResult,
  ) => LofiRuntimeTxQuery<
    LofiQueryFindWithCursorResult<TSchema["tables"][TTableName], TBuilderResult>
  >;
};

export type LofiRuntimeTxRetrieveContext = {
  forSchema: <const TSchema extends AnySchema>(
    schema: TSchema,
    options?: LofiQueryEngineOptions,
  ) => LofiRuntimeTxSchemaRead<TSchema>;
};

export type LofiRuntimeTxTransformContext<TRetrieveResult> = {
  retrieveResult: TRetrieveResult;
};

export type LofiRuntimeTxResult<
  TRetrieveResult,
  TTransformResult,
  HasTransform extends boolean,
> = HasTransform extends true ? TTransformResult : TRetrieveResult;

export type LofiRuntimeTxBuilder<
  TRetrieveResult = [],
  TTransformResult = unknown,
  HasTransform extends boolean = false,
> = {
  readonly [lofiRuntimeTxBuilderBrand]: true;

  retrieve: <TSelection>(
    fn: (
      ctx: LofiRuntimeTxRetrieveContext,
    ) => TSelection extends PromiseLike<unknown> ? never : TSelection,
  ) => LofiRuntimeTxBuilder<LofiRuntimeTxResolved<TSelection>, TTransformResult>;

  transform: <TNewTransformResult>(
    fn: (ctx: LofiRuntimeTxTransformContext<TRetrieveResult>) => TNewTransformResult,
  ) => LofiRuntimeTxBuilder<TRetrieveResult, Awaited<TNewTransformResult>, true>;

  execute: () => Promise<LofiRuntimeTxResult<TRetrieveResult, TTransformResult, HasTransform>>;
};

export type LofiRuntimeTxFactory = () => LofiRuntimeTxBuilder;

type LofiRuntimeTxOptions = {
  adapter: LofiQueryableAdapter;
  whenBootstrapped: () => Promise<void>;
};

type LofiRuntimeTxState = {
  retrieveFn?: (ctx: LofiRuntimeTxRetrieveContext) => unknown;
  transformFn?: (ctx: LofiRuntimeTxTransformContext<unknown>) => unknown;
};

const createQueryToken = <TResult>(execute: () => Promise<TResult>): LofiRuntimeTxQuery<TResult> =>
  ({
    [lofiRuntimeTxQueryBrand]: true,
    execute,
  }) as LofiRuntimeTxQuery<TResult>;

const isQueryToken = (value: unknown): value is LofiRuntimeTxQuery<unknown> =>
  typeof value === "object" &&
  (value as { [lofiRuntimeTxQueryBrand]?: boolean })?.[lofiRuntimeTxQueryBrand] === true;

const resolveSelection = async (selection: unknown): Promise<unknown> => {
  if (isQueryToken(selection)) {
    return await selection.execute();
  }

  if (Array.isArray(selection)) {
    return await Promise.all(selection.map((entry) => resolveSelection(entry)));
  }

  if (typeof selection === "object" && selection !== null) {
    const entries = await Promise.all(
      Object.entries(selection).map(async ([key, value]) => [key, await resolveSelection(value)]),
    );
    return Object.fromEntries(entries);
  }

  return selection;
};

const createRetrieveContext = (adapter: LofiQueryableAdapter): LofiRuntimeTxRetrieveContext => ({
  forSchema(schema, options) {
    const query = adapter.createQueryEngine(schema, options);
    return {
      find(table, builderFn) {
        return createQueryToken(() => query.find(table, builderFn));
      },
      findFirst(table, builderFn) {
        return createQueryToken(() => query.findFirst(table, builderFn));
      },
      findWithCursor(table, builderFn) {
        return createQueryToken(() => query.findWithCursor(table, builderFn));
      },
    };
  },
});

class RuntimeTxBuilder<
  TRetrieveResult,
  TTransformResult,
  HasTransform extends boolean,
> implements LofiRuntimeTxBuilder<TRetrieveResult, TTransformResult, HasTransform> {
  readonly [lofiRuntimeTxBuilderBrand] = true;
  private readonly options: LofiRuntimeTxOptions;
  private readonly state: LofiRuntimeTxState;

  constructor(options: LofiRuntimeTxOptions, state: LofiRuntimeTxState = {}) {
    this.options = options;
    this.state = state;
  }

  retrieve<TSelection>(
    fn: (ctx: LofiRuntimeTxRetrieveContext) => TSelection,
  ): LofiRuntimeTxBuilder<LofiRuntimeTxResolved<TSelection>, TTransformResult> {
    return new RuntimeTxBuilder(this.options, { ...this.state, retrieveFn: fn }) as never;
  }

  transform<TNewTransformResult>(
    fn: (ctx: LofiRuntimeTxTransformContext<TRetrieveResult>) => TNewTransformResult,
  ): LofiRuntimeTxBuilder<TRetrieveResult, Awaited<TNewTransformResult>, true> {
    return new RuntimeTxBuilder(this.options, { ...this.state, transformFn: fn as never }) as never;
  }

  async execute(): Promise<LofiRuntimeTxResult<TRetrieveResult, TTransformResult, HasTransform>> {
    await this.options.whenBootstrapped();

    const retrieveResult = this.state.retrieveFn
      ? await resolveSelection(this.state.retrieveFn(createRetrieveContext(this.options.adapter)))
      : [];

    if (this.state.transformFn) {
      return (await this.state.transformFn({ retrieveResult })) as never;
    }

    return retrieveResult as never;
  }
}

export const createLofiRuntimeTx = (options: LofiRuntimeTxOptions): LofiRuntimeTxBuilder =>
  new RuntimeTxBuilder<[], unknown, false>(options);

export const isLofiRuntimeTxBuilder = (value: unknown): value is LofiRuntimeTxBuilder<unknown> =>
  typeof value === "object" &&
  (value as { [lofiRuntimeTxBuilderBrand]?: boolean })?.[lofiRuntimeTxBuilderBrand] === true;
