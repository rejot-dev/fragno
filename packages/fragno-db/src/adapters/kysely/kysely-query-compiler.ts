import type { CompiledQuery } from "kysely";
import type { AbstractQueryCompiler } from "../../query/query-compiler";
import type { AnySchema, AnyTable } from "../../schema/create";
import { buildCondition } from "../../query/condition-builder";
import { buildFindOptions } from "../../query/orm/orm";
import type { KyselyConfig } from "./kysely-adapter";
import { createKyselyQueryBuilder } from "./query-builder";
import { encodeValues } from "./result-transform";

export function createKyselyQueryCompiler<T extends AnySchema>(
  schema: T,
  config: KyselyConfig,
): AbstractQueryCompiler<T, CompiledQuery> {
  const { db: kysely, provider } = config;
  const queryBuilder = createKyselyQueryBuilder(kysely, provider);

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
      // Encode values before passing to query builder
      const encodedValues = encodeValues(values, table, true, provider);

      return queryBuilder.create(table, encodedValues);
    },

    createMany(name, values) {
      const table = toTable(name);
      // Encode all values before passing to query builder
      const encodedValues = values.map((v) => encodeValues(v, table, true, provider));

      return queryBuilder.createMany(table, encodedValues);
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

      // Encode the set values
      const encodedSet = encodeValues(set, table, false, provider);

      return queryBuilder.updateMany(table, { set: encodedSet, where: conditions });
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

      return queryBuilder.deleteMany(table, { where: conditions });
    },
  } satisfies AbstractQueryCompiler<T, CompiledQuery>;
}
