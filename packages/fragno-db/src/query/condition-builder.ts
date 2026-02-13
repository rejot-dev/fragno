import type { AnyColumn, FragnoId, IdColumn } from "../schema/create";
import { dbNow, type DbNow } from "./db-now";

export type ConditionType = "compare" | "and" | "or" | "not";

export type Condition =
  | {
      type: "compare";
      a: AnyColumn;
      operator: Operator;
      b: AnyColumn | unknown | null;
    }
  | {
      type: "or" | "and";
      items: Condition[];
    }
  | {
      type: "not";
      item: Condition;
    };

// TODO: we temporarily dropped support for comparing against another column, because Prisma ORM still have problems with it.

/**
 * Helper type that allows FragnoId for ID columns and reference columns (bigint).
 * Used in ConditionBuilder to accept FragnoId values in where conditions.
 */
type AcceptsFragnoId<T extends AnyColumn> = T extends IdColumn
  ? T["$in"] | FragnoId
  : T["$in"] extends bigint
    ? T["$in"] | FragnoId
    : T["$in"];

export type ConditionBuilder<Columns extends Record<string, AnyColumn>> = {
  <ColName extends keyof Columns>(
    a: ColName,
    operator: (typeof valueOperators)[number] | (typeof stringOperators)[number],
    b: AcceptsFragnoId<Columns[ColName]> | null,
  ): Condition;

  <ColName extends keyof Columns>(
    a: ColName,
    operator: (typeof arrayOperators)[number],
    b: AcceptsFragnoId<Columns[ColName]>[],
  ): Condition;

  /**
   * Boolean values
   */
  <ColName extends keyof Columns>(a: ColName): Condition;

  and: (...v: (Condition | boolean)[]) => Condition | boolean;
  or: (...v: (Condition | boolean)[]) => Condition | boolean;
  not: (v: Condition | boolean) => Condition | boolean;

  isNull: (a: keyof Columns) => Condition;
  isNotNull: (a: keyof Columns) => Condition;
  now: () => DbNow;
};

// replacement for `like` (Prisma doesn't support `like`)
const stringOperators = [
  "contains",
  "starts with",
  "ends with",

  "not contains",
  "not starts with",
  "not ends with",
  // excluded `regexp` since MSSQL doesn't support it, may re-consider
] as const;

const arrayOperators = ["in", "not in"] as const;

const valueOperators = ["=", "!=", ">", ">=", "<", "<=", "is", "is not"] as const;

// JSON specific operators are not included, some databases don't support them
// `match` requires additional extensions & configurations on SQLite and PostgreSQL
// MySQL & SQLite requires workarounds to support `ilike`
export const operators = [...valueOperators, ...arrayOperators, ...stringOperators] as const;

export type Operator = (typeof operators)[number];

export function createBuilder<Columns extends Record<string, AnyColumn>>(
  columns: Columns,
): ConditionBuilder<Columns> {
  function col(name: keyof Columns) {
    const out = columns[name];
    if (!out) {
      throw new Error(`Invalid column name ${String(name)}`);
    }

    return out;
  }

  const builder: ConditionBuilder<Columns> = (...args: [string, Operator, unknown] | [string]) => {
    if (args.length === 3) {
      const [a, operator, b] = args;

      if (!operators.includes(operator)) {
        throw new Error(`Unsupported operator: ${operator}`);
      }

      return {
        type: "compare",
        a: col(a),
        b,
        operator,
      };
    }

    return {
      type: "compare",
      a: col(args[0]),
      operator: "=",
      b: true,
    };
  };

  builder.isNull = (a) => builder(a, "is", null);
  builder.isNotNull = (a) => builder(a, "is not", null);
  builder.now = () => dbNow();
  builder.not = (condition) => {
    if (typeof condition === "boolean") {
      return !condition;
    }

    return {
      type: "not",
      item: condition,
    };
  };

  builder.or = (...conditions) => {
    const out = {
      type: "or",
      items: [] as Condition[],
    } as const;

    for (const item of conditions) {
      if (item === true) {
        return true;
      }
      if (item === false) {
        continue;
      }

      out.items.push(item);
    }

    if (out.items.length === 0) {
      return false;
    }
    return out;
  };

  builder.and = (...conditions) => {
    const out = {
      type: "and",
      items: [] as Condition[],
    } as const;

    for (const item of conditions) {
      if (item === true) {
        continue;
      }
      if (item === false) {
        return false;
      }

      out.items.push(item);
    }

    if (out.items.length === 0) {
      return true;
    }
    return out;
  };

  return builder;
}

export function buildCondition<T, Columns extends Record<string, AnyColumn>>(
  columns: Columns,
  input: (builder: ConditionBuilder<Columns>) => T,
): T {
  return input(createBuilder(columns));
}

/**
 * Create a ConditionBuilder that only allows comparisons on indexed columns.
 * Used in Unit of Work to ensure queries can leverage indexes for optimal performance.
 *
 * @param columns - The full set of columns from the table
 * @param indexedColumnNames - Set of column names that are part of indexes
 * @returns A ConditionBuilder restricted to indexed columns only
 *
 * @example
 * ```ts
 * const builder = createIndexedBuilder(
 *   table.columns,
 *   new Set(["id", "userId", "createdAt"])
 * );
 * const condition = builder("userId", "=", "123");
 * ```
 */
export function createIndexedBuilder<Columns extends Record<string, AnyColumn>>(
  columns: Columns,
  indexedColumnNames: Set<string>,
): ConditionBuilder<Columns> {
  function col(name: keyof Columns) {
    const columnName = String(name);

    if (!indexedColumnNames.has(columnName)) {
      throw new Error(
        `Column "${columnName}" is not indexed. Only indexed columns can be used in Unit of Work queries. ` +
          `Available indexed columns: ${Array.from(indexedColumnNames).join(", ")}`,
      );
    }

    const out = columns[name];
    if (!out) {
      throw new Error(`Invalid column name ${columnName}`);
    }

    return out;
  }

  const builder: ConditionBuilder<Columns> = (...args: [string, Operator, unknown] | [string]) => {
    if (args.length === 3) {
      const [a, operator, b] = args;

      if (!operators.includes(operator)) {
        throw new Error(`Unsupported operator: ${operator}`);
      }

      return {
        type: "compare",
        a: col(a),
        b,
        operator,
      };
    }

    return {
      type: "compare",
      a: col(args[0]),
      operator: "=",
      b: true,
    };
  };

  builder.isNull = (a) => builder(a, "is", null);
  builder.isNotNull = (a) => builder(a, "is not", null);
  builder.now = () => dbNow();
  builder.not = (condition) => {
    if (typeof condition === "boolean") {
      return !condition;
    }

    return {
      type: "not",
      item: condition,
    };
  };

  builder.or = (...conditions) => {
    const out = {
      type: "or",
      items: [] as Condition[],
    } as const;

    for (const item of conditions) {
      if (item === true) {
        return true;
      }
      if (item === false) {
        continue;
      }

      out.items.push(item);
    }

    if (out.items.length === 0) {
      return false;
    }
    return out;
  };

  builder.and = (...conditions) => {
    const out = {
      type: "and",
      items: [] as Condition[],
    } as const;

    for (const item of conditions) {
      if (item === true) {
        continue;
      }
      if (item === false) {
        return false;
      }

      out.items.push(item);
    }

    if (out.items.length === 0) {
      return true;
    }
    return out;
  };

  return builder;
}
