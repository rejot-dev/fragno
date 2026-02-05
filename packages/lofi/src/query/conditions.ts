import type { AnyColumn } from "@fragno-dev/db/schema";

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

export type ConditionBuilder<Columns extends Record<string, AnyColumn>> = {
  <ColName extends keyof Columns>(
    a: ColName,
    operator: (typeof valueOperators)[number] | (typeof stringOperators)[number],
    b: Columns[ColName]["$in"] | null,
  ): Condition;

  <ColName extends keyof Columns>(
    a: ColName,
    operator: (typeof arrayOperators)[number],
    b: Columns[ColName]["$in"][],
  ): Condition;

  <ColName extends keyof Columns>(a: ColName): Condition;

  and: (...v: (Condition | boolean)[]) => Condition | boolean;
  or: (...v: (Condition | boolean)[]) => Condition | boolean;
  not: (v: Condition | boolean) => Condition | boolean;

  isNull: (a: keyof Columns) => Condition;
  isNotNull: (a: keyof Columns) => Condition;
};

const stringOperators = [
  "contains",
  "starts with",
  "ends with",

  "not contains",
  "not starts with",
  "not ends with",
] as const;

const arrayOperators = ["in", "not in"] as const;

const valueOperators = ["=", "!=", ">", ">=", "<", "<=", "is", "is not"] as const;

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
