import type { AbstractQuery } from "../../query/query";
import type { AnySchema } from "../../schema/create";
import type { KyselyConfig } from "./kysely-adapter";
import type { CompiledMutation, UOWDecoder, UOWExecutor } from "../../query/unit-of-work";
import { decodeResult } from "../../query/result-transform";
import { createKyselyUOWCompiler } from "./kysely-uow-compiler";
import { executeKyselyRetrievalPhase, executeKyselyMutationPhase } from "./kysely-uow-executor";
import { UnitOfWork } from "../../query/unit-of-work";
import type { CompiledQuery } from "kysely";

/**
 * Creates a Kysely-based query engine for the given schema.
 *
 * This is the main entry point for creating a database query interface using Kysely.
 * It uses a compiler-based architecture where queries are compiled to SQL and then executed,
 * enabling features like SQL snapshot testing.
 *
 * @param schema - The database schema definition
 * @param config - Kysely configuration containing the database instance and provider
 * @returns An AbstractQuery instance for performing database operations
 *
 * @example
 * ```ts
 * const queryEngine = fromKysely(mySchema, {
 *   db: kysely,
 *   provider: 'postgresql'
 * });
 *
 * const users = await queryEngine.findMany('users', {
 *   where: (b) => b('age', '>', 18),
 *   orderBy: [['name', 'asc']]
 * });
 * ```
 */
export function fromKysely<T extends AnySchema>(schema: T, config: KyselyConfig): AbstractQuery<T> {
  const { db: kysely, provider } = config;
  const uowCompiler = createKyselyUOWCompiler(schema, config);

  function createUOW(name?: string): UnitOfWork<T, []> {
    const executor: UOWExecutor<CompiledQuery, unknown> = {
      executeRetrievalPhase: (retrievalBatch: CompiledQuery[]) =>
        executeKyselyRetrievalPhase(kysely, retrievalBatch),
      executeMutationPhase: (mutationBatch: CompiledMutation<CompiledQuery>[]) =>
        executeKyselyMutationPhase(kysely, mutationBatch),
    };

    // Create a decoder function to transform raw results into application format
    const decoder: UOWDecoder<T> = (rawResults, ops) => {
      if (rawResults.length !== ops.length) {
        throw new Error("rawResults and ops must have the same length");
      }

      return rawResults.map((rows, index) => {
        const op = ops[index];
        if (!op) {
          throw new Error("op must be defined");
        }

        // Handle count operations differently - return the count number directly
        if (op.type === "count") {
          const rowArray = rows as Record<string, unknown>[];
          const firstRow = rowArray[0];
          if (!firstRow) {
            return 0;
          }
          const count = Number(firstRow["count"]);
          if (Number.isNaN(count)) {
            throw new Error(`Unexpected result for count, received: ${count}`);
          }
          return count;
        }

        // Each result is an array of rows - decode each row
        const rowArray = rows as Record<string, unknown>[];
        return rowArray.map((row) => decodeResult(row, op.table, provider));
      });
    };

    return new UnitOfWork(schema, uowCompiler, executor, decoder, name);
  }

  return {
    async find(tableName, builderFn) {
      const uow = createUOW();
      uow.find(tableName, builderFn);
      // executeRetrieve returns an array of results (one per find operation)
      // Since we only have one find, unwrap the first result
      const [result]: unknown[][] = await uow.executeRetrieve();
      return result ?? [];
    },

    async findFirst(tableName, builderFn) {
      const uow = createUOW();
      if (builderFn) {
        uow.find(tableName, (b) => builderFn(b as never).pageSize(1));
      } else {
        uow.find(tableName, (b) => b.whereIndex("primary").pageSize(1));
      }
      // executeRetrieve runs an array of `find` operation results, which each return an array of rows
      const [result]: unknown[][] = await uow.executeRetrieve();
      return result?.[0] ?? null;
    },

    async create(tableName, values) {
      const uow = createUOW();
      uow.create(tableName, values);
      const { success } = await uow.executeMutations();
      if (!success) {
        // This should not happen because we don't `.check()` this call.
        // TODO: Verify what happens when there are unique constraints
        throw new Error("Failed to create record");
      }

      const [createdId] = uow.getCreatedIds();
      if (!createdId) {
        throw new Error("Failed to get created ID");
      }
      return createdId;
    },

    async createMany(tableName, valuesArray) {
      const uow = createUOW();
      for (const values of valuesArray) {
        uow.create(tableName, values);
      }
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to create records");
      }

      return uow.getCreatedIds();
    },

    async update(tableName, id, builderFn) {
      const uow = createUOW();
      uow.update(tableName, id, builderFn);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to update record (version conflict or record not found)");
      }
    },

    async updateMany(tableName, builderFn) {
      // Create a special builder that captures both where and set operations
      let whereConfig: { indexName?: string; condition?: unknown } = {};
      let setValues: unknown;

      const specialBuilder = {
        whereIndex(indexName: string, condition?: unknown) {
          whereConfig = { indexName, condition };
          return this;
        },
        set(values: unknown) {
          setValues = values;
          return this;
        },
      };

      builderFn(specialBuilder);

      if (!whereConfig.indexName) {
        throw new Error("whereIndex() must be called in updateMany");
      }
      if (!setValues) {
        throw new Error("set() must be called in updateMany");
      }

      // First, find all matching records
      const findUow = createUOW();
      findUow.find(tableName, (b) => {
        if (whereConfig.condition) {
          return b.whereIndex(whereConfig.indexName as never, whereConfig.condition as never);
        }
        return b.whereIndex(whereConfig.indexName as never);
      });
      const findResults: unknown[][] = await findUow.executeRetrieve();
      const records = findResults[0];

      if (!records || records.length === 0) {
        return;
      }

      // Now update all found records
      const updateUow = createUOW();
      for (const record of records as never as Array<{ id: unknown }>) {
        updateUow.update(tableName as string, record.id as string, (b) =>
          b.set(setValues as never),
        );
      }
      const { success } = await updateUow.executeMutations();
      if (!success) {
        throw new Error("Failed to update records (version conflict)");
      }
    },

    async delete(tableName, id, builderFn) {
      const uow = createUOW();
      uow.delete(tableName, id, builderFn as never);
      const { success } = await uow.executeMutations();
      if (!success) {
        throw new Error("Failed to delete record (version conflict or record not found)");
      }
    },

    async deleteMany(tableName, builderFn) {
      // Create a special builder that captures where configuration
      let whereConfig: { indexName?: string; condition?: unknown } = {};

      const specialBuilder = {
        whereIndex(indexName: string, condition?: unknown) {
          whereConfig = { indexName, condition };
          return this;
        },
      };

      // Safe: Call builderFn to capture the configuration
      builderFn(specialBuilder as never);

      if (!whereConfig.indexName) {
        throw new Error("whereIndex() must be called in deleteMany");
      }

      // First, find all matching records
      const findUow = createUOW();
      findUow.find(tableName as string, (b) => {
        if (whereConfig.condition) {
          return b.whereIndex(whereConfig.indexName as never, whereConfig.condition as never);
        }
        return b.whereIndex(whereConfig.indexName as never);
      });
      const findResults2 = await findUow.executeRetrieve();
      const records = (findResults2 as unknown as [unknown])[0];

      // @ts-expect-error - Type narrowing doesn't work through unknown cast
      if (!records || records.length === 0) {
        return;
      }

      // Now delete all found records
      const deleteUow = createUOW();
      for (const record of records as never as Array<{ id: unknown }>) {
        deleteUow.delete(tableName as string, record.id as string);
      }
      const { success } = await deleteUow.executeMutations();
      if (!success) {
        throw new Error("Failed to delete records (version conflict)");
      }
    },

    createUnitOfWork(name) {
      return createUOW(name);
    },
  } as AbstractQuery<T>;
}
