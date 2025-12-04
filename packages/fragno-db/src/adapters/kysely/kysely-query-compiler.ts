import type { CompiledQuery } from "kysely";
import type { AnySchema, AnyTable } from "../../schema/create";
import { buildCondition } from "../../query/condition-builder";
import { buildFindOptions } from "../../query/orm/orm";
import { createKyselyQueryBuilder } from "./kysely-query-builder";
import type { ConditionBuilder, Condition } from "../../query/condition-builder";
import { createKysely } from "./kysely-shared";
import type { TableNameMapper } from "../shared/table-name-mapper";
import type { SQLProvider } from "../../shared/providers";

/**
 * Internal query compiler interface for Kysely
 * Used by the UOW compiler to generate compiled queries
 */
export interface KyselyQueryCompiler {
  count: (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { where?: (eb: ConditionBuilder<any>) => any },
  ) => CompiledQuery | null;
  findFirst: (name: string, options: any) => CompiledQuery | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  findMany: (name: string, options?: any) => CompiledQuery | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  create: (name: string, values: any) => CompiledQuery; // eslint-disable-line @typescript-eslint/no-explicit-any
  createMany: (name: string, values: any[]) => CompiledQuery; // eslint-disable-line @typescript-eslint/no-explicit-any
  updateMany: (name: string, options: { set: any; where?: any }) => CompiledQuery | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  deleteMany: (name: string, options: { where?: any }) => CompiledQuery | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function createKyselyQueryCompiler<T extends AnySchema>(
  schema: T,
  provider: SQLProvider,
  mapper?: TableNameMapper,
): KyselyQueryCompiler {
  // Get kysely instance for query building (compilation doesn't execute, just builds SQL)
  const kysely = createKysely(provider);
  const queryBuilder = createKyselyQueryBuilder(kysely, provider, mapper);

  function toTable(name: unknown): AnyTable {
    const table = schema.tables[name as string];
    if (!table) {
      throw new Error(`Invalid table name ${name}.`);
    }
    return table;
  }

  return {
    count(name, { where } = {}) {
      const table = toTable(name);
      let conditions = where ? buildCondition(table.columns, where) : undefined;
      if (conditions === true) {
        conditions = undefined;
      }
      if (conditions === false) {
        return null;
      }

      return queryBuilder.count(table, { where: conditions });
    },

    findFirst(name, options) {
      const table = toTable(name);
      // Safe cast: FindFirstOptions is structurally compatible with FindManyOptions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compiledOptions = buildFindOptions(table, options as any);
      if (compiledOptions === false) {
        return null;
      }

      return queryBuilder.findMany(table, {
        ...compiledOptions,
        limit: 1,
      });
    },

    findMany(name, options = {}) {
      const table = toTable(name);
      // Safe cast: FindManyOptions from compiler matches FindManyOptions from buildFindOptions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compiledOptions = buildFindOptions(table, options as any);
      if (compiledOptions === false) {
        return null;
      }

      return queryBuilder.findMany(table, compiledOptions);
    },

    create(name, values) {
      const table = toTable(name);
      return queryBuilder.create(table, values);
    },

    createMany(name, values) {
      const table = toTable(name);
      return queryBuilder.createMany(table, values);
    },

    updateMany(name, { set, where }) {
      const table = toTable(name);
      let conditions = where ? buildCondition(table.columns, where) : undefined;
      if (conditions === true) {
        conditions = undefined;
      }
      if (conditions === false) {
        return null;
      }

      // Safe: conditions is Condition | undefined after filtering out true/false
      return queryBuilder.updateMany(table, {
        set,
        where: conditions as Condition | undefined,
      });
    },

    deleteMany(name, { where }) {
      const table = toTable(name);
      let conditions = where ? buildCondition(table.columns, where) : undefined;
      if (conditions === true) {
        conditions = undefined;
      }
      if (conditions === false) {
        return null;
      }

      // Safe: conditions is Condition | undefined after filtering out true/false
      return queryBuilder.deleteMany(table, { where: conditions as Condition | undefined });
    },
  };
}
