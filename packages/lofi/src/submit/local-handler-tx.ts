import { createHandlerTxBuilder, UnitOfWork, type HandlerTxBuilder } from "@fragno-dev/db";
import type {
  CompiledMutation,
  MutationOperation,
  RetrievalOperation,
  UOWCompiler,
  UOWDecoder,
  UOWExecutor,
} from "@fragno-dev/db/unit-of-work";
import { FragnoId } from "@fragno-dev/db/schema";
import type { AnyColumn, AnySchema, AnyTable } from "@fragno-dev/db/schema";
import type { IndexedDbQueryContext } from "../query/engine";
import { executeIndexedDbRetrievalOperation } from "../query/engine";
import type { Condition, ConditionBuilder } from "../query/conditions";
import type { LofiMutation } from "../types";

type HandlerTxOptions = Parameters<typeof createHandlerTxBuilder>[0];

export type LocalHandlerTxFactory = (
  options?: Omit<HandlerTxOptions, "createUnitOfWork">,
) => HandlerTxBuilder<readonly [], [], [], unknown, unknown, false, false, false, false, {}>;

export type LocalHandlerCommandDefinition<TInput = unknown, TContext = unknown> = {
  name: string;
  handler: (args: { input: TInput; tx: LocalHandlerTxFactory; ctx: TContext }) => Promise<unknown>;
};

type LocalHandlerTxAdapter = {
  applyMutations?(mutations: LofiMutation[]): Promise<void>;
  createQueryContext?: (schemaName: string) => IndexedDbQueryContext;
};

type LocalRetrievalOperation =
  | {
      type: "find";
      table: AnyTable;
      indexName: string;
      options: {
        useIndex: string;
        where?:
          | ((builder: ConditionBuilder<Record<string, AnyColumn>>) => Condition | boolean)
          | Condition;
        pageSize?: number;
      };
      withCursor: boolean;
    }
  | {
      type: "count";
      table: AnyTable;
      indexName: string;
      options: {
        where?:
          | ((builder: ConditionBuilder<Record<string, AnyColumn>>) => Condition | boolean)
          | Condition;
      };
    };

export type LocalHandlerQueryExecutor<TContext> = {
  createQueryContext: (schemaName: string) => TContext;
  executeRetrievalOperation: (options: {
    operation: LocalRetrievalOperation;
    context: TContext;
  }) => Promise<unknown>;
};

export type LocalHandlerTxOptions<TContext = IndexedDbQueryContext> = {
  adapter: LocalHandlerTxAdapter;
  schemas: AnySchema[];
  queryExecutor?: LocalHandlerQueryExecutor<TContext>;
};

type LocalCompiledOperation = RetrievalOperation<AnySchema> | MutationOperation<AnySchema>;

const createLocalVersionstamp = (): string =>
  `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getExternalId = (id: FragnoId | string): string =>
  typeof id === "string" ? id : id.externalId;

const buildLocalMutation = (
  operation: MutationOperation<AnySchema>,
  versionstamp: string,
): LofiMutation | null => {
  if (operation.type === "create") {
    return {
      op: "create",
      schema: operation.schema.name,
      table: operation.table,
      externalId: operation.generatedExternalId,
      values: operation.values as Record<string, unknown>,
      versionstamp,
    };
  }

  if (operation.type === "update") {
    return {
      op: "update",
      schema: operation.schema.name,
      table: operation.table,
      externalId: getExternalId(operation.id),
      set: operation.set as Record<string, unknown>,
      versionstamp,
    };
  }

  if (operation.type === "delete") {
    return {
      op: "delete",
      schema: operation.schema.name,
      table: operation.table,
      externalId: getExternalId(operation.id),
      versionstamp,
    };
  }

  return null;
};

const isFindOrCount = (
  operation: LocalCompiledOperation,
): operation is RetrievalOperation<AnySchema> =>
  operation.type === "find" || operation.type === "count";

const isMutationOperation = (
  operation: LocalCompiledOperation,
): operation is MutationOperation<AnySchema> =>
  operation.type === "create" ||
  operation.type === "update" ||
  operation.type === "delete" ||
  operation.type === "check";

const buildFindKeyCondition = (
  table: AnyTable,
  externalId: string,
): ((builder: ConditionBuilder<Record<string, AnyColumn>>) => Condition | boolean) => {
  const idColumn = table.getIdColumn();
  return (eb) => eb(idColumn.name, "=", externalId);
};

const resolveQueryContext = <TContext>(
  executor: LocalHandlerQueryExecutor<TContext>,
  schema: AnySchema,
): TContext => executor.createQueryContext(schema.name);

const getRowVersion = async <TContext>(
  executor: LocalHandlerQueryExecutor<TContext>,
  schema: AnySchema,
  table: AnyTable,
  externalId: string,
): Promise<number | null> => {
  const context = resolveQueryContext(executor, schema);
  const result = await executor.executeRetrievalOperation({
    operation: {
      type: "find",
      table,
      indexName: "_primary",
      options: {
        useIndex: "_primary",
        where: buildFindKeyCondition(table, externalId),
        pageSize: 1,
      },
      withCursor: false,
    },
    context,
  });

  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  const idColumn = table.getIdColumn();
  const row = result[0] as Record<string, unknown>;
  const idValue = row[idColumn.name];
  if (idValue && typeof idValue === "object" && "version" in idValue) {
    return (idValue as FragnoId).version;
  }

  return null;
};

const validateMutationChecks = async <TContext>(
  executor: LocalHandlerQueryExecutor<TContext>,
  mutationBatch: CompiledMutation<LocalCompiledOperation>[],
): Promise<boolean> => {
  for (const mutation of mutationBatch) {
    const operation = mutation.operation;
    if (!operation || !isMutationOperation(operation)) {
      continue;
    }

    if (operation.type === "check") {
      const externalId = getExternalId(operation.id);
      const version = operation.id instanceof FragnoId ? operation.id.version : undefined;
      if (version === undefined) {
        return false;
      }
      const currentVersion = await getRowVersion(
        executor,
        operation.schema,
        operation.schema.tables[operation.table],
        externalId,
      );
      if (currentVersion === null || currentVersion !== version) {
        return false;
      }
      continue;
    }

    if ((operation.type === "update" || operation.type === "delete") && operation.checkVersion) {
      const externalId = getExternalId(operation.id);
      const version = operation.id instanceof FragnoId ? operation.id.version : undefined;
      if (version === undefined) {
        return false;
      }
      const currentVersion = await getRowVersion(
        executor,
        operation.schema,
        operation.schema.tables[operation.table],
        externalId,
      );
      if (currentVersion === null || currentVersion !== version) {
        return false;
      }
    }
  }

  return true;
};

const collectCreatedInternalIds = async <TContext>(
  executor: LocalHandlerQueryExecutor<TContext>,
  mutationBatch: CompiledMutation<LocalCompiledOperation>[],
): Promise<(bigint | null)[]> => {
  const created: (bigint | null)[] = [];

  for (const mutation of mutationBatch) {
    const operation = mutation.operation;
    if (!operation || operation.type !== "create") {
      continue;
    }

    const table = operation.schema.tables[operation.table];
    const context = resolveQueryContext(executor, operation.schema);
    const result = await executor.executeRetrievalOperation({
      operation: {
        type: "find",
        table,
        indexName: "_primary",
        options: {
          useIndex: "_primary",
          where: buildFindKeyCondition(table, operation.generatedExternalId),
          pageSize: 1,
        },
        withCursor: false,
      },
      context,
    });

    const row = Array.isArray(result) ? result[0] : undefined;
    if (!row) {
      created.push(null);
      continue;
    }

    const idColumn = table.getIdColumn();
    const idValue = (row as Record<string, unknown>)[idColumn.name];
    if (idValue && typeof idValue === "object" && "internalId" in idValue) {
      const internalId = (idValue as FragnoId).internalId;
      created.push(internalId ?? null);
    } else {
      created.push(null);
    }
  }

  return created;
};

export const createLocalHandlerTx = <TContext>(
  options: LocalHandlerTxOptions<TContext>,
): LocalHandlerTxFactory => {
  const schemaNamespaceMap = new WeakMap<AnySchema, string | null>();
  for (const schema of options.schemas) {
    schemaNamespaceMap.set(schema, schema.name);
  }

  const queryExecutor: LocalHandlerQueryExecutor<TContext> =
    options.queryExecutor ??
    (() => {
      if (!options.adapter.createQueryContext) {
        throw new Error(
          "Local handler tx requires a queryExecutor or adapter.createQueryContext().",
        );
      }
      return {
        createQueryContext: options.adapter.createQueryContext.bind(options.adapter),
        executeRetrievalOperation: executeIndexedDbRetrievalOperation,
      } as unknown as LocalHandlerQueryExecutor<TContext>;
    })();

  const compiler: UOWCompiler<LocalCompiledOperation> = {
    compileRetrievalOperation(op: RetrievalOperation<AnySchema>): LocalCompiledOperation | null {
      return op;
    },
    compileMutationOperation(
      op: MutationOperation<AnySchema>,
    ): CompiledMutation<LocalCompiledOperation> | null {
      return {
        query: op,
        operation: op,
        op: op.type,
        expectedAffectedRows: null,
        expectedReturnedRows: null,
      };
    },
  };

  const executor: UOWExecutor<LocalCompiledOperation, unknown> = {
    async executeRetrievalPhase(retrievalBatch: LocalCompiledOperation[]): Promise<unknown[]> {
      const results: unknown[] = [];

      for (const compiled of retrievalBatch) {
        if (!isFindOrCount(compiled)) {
          throw new Error(`Unsupported local retrieval operation: ${compiled.type}`);
        }

        const context = resolveQueryContext(queryExecutor, compiled.schema);
        const result = await queryExecutor.executeRetrievalOperation({
          operation:
            compiled.type === "count"
              ? {
                  type: "count",
                  table: compiled.table,
                  indexName: compiled.indexName,
                  options: { where: compiled.options.where },
                }
              : {
                  type: "find",
                  table: compiled.table,
                  indexName: compiled.indexName,
                  options: compiled.options,
                  withCursor: compiled.withCursor ?? false,
                },
          context,
        });

        results.push(result);
      }

      return results;
    },

    async executeMutationPhase(mutationBatch: CompiledMutation<LocalCompiledOperation>[]) {
      if (mutationBatch.length === 0) {
        return { success: true, createdInternalIds: [] };
      }

      const checksOk = await validateMutationChecks(queryExecutor, mutationBatch);
      if (!checksOk) {
        return { success: false };
      }

      if (!options.adapter.applyMutations) {
        throw new Error("Lofi adapter does not support applyMutations.");
      }

      const mutations: LofiMutation[] = [];
      for (const compiled of mutationBatch) {
        const operation = compiled.operation;
        if (!operation || !isMutationOperation(operation)) {
          continue;
        }

        const mutation = buildLocalMutation(operation, createLocalVersionstamp());
        if (mutation) {
          mutations.push(mutation);
        }
      }

      if (mutations.length > 0) {
        await options.adapter.applyMutations(mutations);
      }

      const createdInternalIds = await collectCreatedInternalIds(queryExecutor, mutationBatch);
      return { success: true, createdInternalIds };
    },
  };

  const decoder: UOWDecoder<unknown> = {
    decode(rawResults) {
      return rawResults;
    },
  };

  return (execOptions?: Omit<HandlerTxOptions, "createUnitOfWork">) =>
    createHandlerTxBuilder({
      ...execOptions,
      createUnitOfWork: () => {
        const uow = new UnitOfWork(
          compiler,
          executor,
          decoder,
          undefined,
          undefined,
          schemaNamespaceMap,
        );
        return uow;
      },
    });
};

export const runLocalHandlerCommand = async <TInput, TContext>(options: {
  command: LocalHandlerCommandDefinition<TInput, TContext>;
  input: TInput;
  ctx: TContext;
  tx: LocalHandlerTxFactory;
}): Promise<void> => {
  await options.command.handler({
    input: options.input,
    ctx: options.ctx,
    tx: options.tx,
  });
};
