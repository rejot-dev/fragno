import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";
import {
  QueryTreeFindBuilder,
  type CompiledQueryTreeCountNode,
  type CompiledQueryTreeRootNode,
} from "@fragno-dev/db/unit-of-work";

import type { LofiQueryInterface } from "../types";

export type LofiFindBuilder<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
> = Omit<QueryTreeFindBuilder<TSchema, TSchema["tables"][TTableName]>, "build">;

export type LofiReadPlan<TTable extends AnyTable = AnyTable> =
  | {
      kind: "count";
      resultMode: "find" | "findFirst";
      table: TTable;
      queryTree: CompiledQueryTreeCountNode<TTable>;
    }
  | {
      kind: "find";
      resultMode: "find" | "findFirst" | "findWithCursor";
      table: TTable;
      queryTree: CompiledQueryTreeRootNode<TTable>;
    };

export const lofiExecuteReadPlan = Symbol("lofi.executeReadPlan");

export type LofiExecutableQueryInterface<TSchema extends AnySchema> =
  LofiQueryInterface<TSchema> & {
    [lofiExecuteReadPlan]: (plan: LofiReadPlan) => Promise<unknown>;
  };

export const buildReadPlan = <
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
>(options: {
  schema: TSchema;
  tableName: TTableName;
  builderFn: (builder: LofiFindBuilder<TSchema, TTableName>) => unknown;
  resultMode: LofiReadPlan["resultMode"];
}): LofiReadPlan<TSchema["tables"][TTableName]> => {
  const { schema, tableName, builderFn, resultMode } = options;
  const table = schema.tables[tableName];
  if (!table) {
    throw new Error(`Table ${tableName} not found in schema`);
  }

  const builder = new QueryTreeFindBuilder(
    schema,
    tableName,
    table as TSchema["tables"][TTableName],
  );
  builderFn(builder as LofiFindBuilder<TSchema, TTableName>);
  if (resultMode === "findFirst") {
    builder.pageSize(1);
  }

  const queryTree = builder.build();
  if (queryTree.kind === "count") {
    if (resultMode === "findWithCursor") {
      throw new Error(
        `findWithCursor() does not support selectCount() on table "${tableName}". ` +
          `Use find() or findFirst() instead.`,
      );
    }

    return {
      kind: "count",
      resultMode,
      table: table as TSchema["tables"][TTableName],
      queryTree,
    };
  }

  return {
    kind: "find",
    resultMode,
    table: table as TSchema["tables"][TTableName],
    queryTree,
  };
};
