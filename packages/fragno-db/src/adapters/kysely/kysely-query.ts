import type { AbstractQuery } from "../../query/query";
import type { AnySchema } from "../../schema/create";
import type { KyselyConfig } from "./kysely-adapter";
import type { UOWDecoder } from "../../query/unit-of-work";
import { createKyselyQueryCompiler } from "./kysely-query-compiler";
import { decodeResult, encodeValues } from "../../query/result-transform";
import { createKyselyUOWCompiler } from "./kysely-uow-compiler";
import { executeKyselyRetrievalPhase, executeKyselyMutationPhase } from "./kysely-uow-executor";
import { UnitOfWork } from "../../query/unit-of-work";

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
  const queryCompiler = createKyselyQueryCompiler(schema, config);
  const uowCompiler = createKyselyUOWCompiler(schema, config);

  function getTable(tableName: string) {
    const table = schema.tables[tableName];
    if (!table) {
      throw new Error(`Invalid table name ${tableName}.`);
    }
    return table;
  }

  return {
    async count(name, options) {
      const compiled = queryCompiler.count(name, options);
      if (compiled === null) {
        return 0;
      }

      const result = await kysely.executeQuery(compiled);
      const firstRow = result.rows[0] as Record<string, unknown> | undefined;
      const count = Number(firstRow?.["count"]);
      if (Number.isNaN(count)) {
        throw new Error(`Unexpected result for count, received: ${count}`);
      }
      return count;
    },

    async findFirst(name, options) {
      const compiled = queryCompiler.findFirst(name, options);
      if (compiled === null) {
        return null;
      }

      const result = await kysely.executeQuery(compiled);
      if (result.rows.length === 0) {
        return null;
      }

      const table = getTable(name as string);
      // Safe cast: we know the query returns a record matching our table structure
      return decodeResult(result.rows[0] as Record<string, unknown>, table, provider);
    },

    async findMany(name, options) {
      const compiled = queryCompiler.findMany(name, options);
      if (compiled === null) {
        return [];
      }

      const result = await kysely.executeQuery(compiled);
      const table = getTable(name as string);

      return result.rows.map((row) =>
        // Safe cast: we know the query returns records matching our table structure
        decodeResult(row as Record<string, unknown>, table, provider),
      );
    },

    async create(name, values) {
      // Safe cast: TableToInsertValues types are structurally equivalent between query.ts and query-compiler.ts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compiled = queryCompiler.create(name, values as any);
      const table = getTable(name as string);

      if (provider === "mssql" || provider === "postgresql" || provider === "sqlite") {
        const result = await kysely.executeQuery(compiled);
        // Safe cast: we know the query returns a record matching our table structure
        return decodeResult(result.rows[0] as Record<string, unknown>, table, provider);
      }

      // For MySQL and other providers that don't support RETURNING, we need to do a follow-up query
      const encodedValues = encodeValues(values, table, true, provider);
      const idColumn = table.getIdColumn();
      const idValue = encodedValues[idColumn.name];

      if (idValue == null) {
        throw new Error("cannot find value of id column, which is required for `create()`.");
      }

      await kysely.executeQuery(compiled);

      // Do a follow-up SELECT to get the created record
      const findCompiled = queryCompiler.findFirst(name, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: (b) => b(idColumn.name as any, "=", idValue as any),
      });

      if (findCompiled === null) {
        throw new Error("Failed to compile follow-up query for MySQL create");
      }

      const result = await kysely.executeQuery(findCompiled);
      // Safe cast: we know the query returns a record matching our table structure
      return decodeResult(result.rows[0] as Record<string, unknown>, table, provider);
    },

    async createMany(name, values) {
      // Safe cast: TableToInsertValues types are structurally equivalent between query.ts and query-compiler.ts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compiled = queryCompiler.createMany(name, values as any);
      const table = getTable(name as string);
      const encodedValues = values.map((v) => encodeValues(v, table, true, provider));

      await kysely.executeQuery(compiled);

      return encodedValues.map((value) => ({
        _id: value[table.getIdColumn().name],
      }));
    },

    async updateMany(name, options) {
      // Safe cast: TableToUpdateValues types are structurally equivalent between query.ts and query-compiler.ts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compiled = queryCompiler.updateMany(name, options as any);
      if (compiled === null) {
        return;
      }

      await kysely.executeQuery(compiled);
    },

    async deleteMany(name, options) {
      const compiled = queryCompiler.deleteMany(name, options);
      if (compiled === null) {
        return;
      }

      await kysely.executeQuery(compiled);
    },

    createUnitOfWork(name) {
      const executor = {
        executeRetrievalPhase: (retrievalBatch: unknown[]) =>
          // Safe: retrievalBatch contains kysely queries compiled by uowCompiler
          executeKyselyRetrievalPhase(
            kysely,
            retrievalBatch as Parameters<typeof executeKyselyRetrievalPhase>[1],
          ),
        executeMutationPhase: (mutationBatch: unknown[]) =>
          // Safe: mutationBatch contains kysely queries compiled by uowCompiler
          executeKyselyMutationPhase(
            kysely,
            mutationBatch as Parameters<typeof executeKyselyMutationPhase>[1],
          ),
      };

      // Create a decoder function to transform raw results into application format
      const decoder: UOWDecoder<typeof schema> = (rawResults, ops) => {
        if (rawResults.length !== ops.length) {
          throw new Error("rawResults and ops must have the same length");
        }

        return rawResults.map((rows, index) => {
          const op = ops[index];
          if (!op) {
            throw new Error("op must be defined");
          }

          // Each result is an array of rows - decode each row
          const rowArray = rows as Record<string, unknown>[];
          return rowArray.map((row) => decodeResult(row, op.table, provider));
        });
      };

      return new UnitOfWork(schema, uowCompiler, executor, decoder, name);
    },
  } as AbstractQuery<T>;
}
