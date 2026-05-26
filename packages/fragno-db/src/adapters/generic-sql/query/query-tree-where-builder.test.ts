import { describe, expect, it } from "vitest";

import type { Condition } from "../../../query/condition-builder";
import { ParentColumnRef } from "../../../query/unit-of-work/query-tree";
import { column, FragnoReference, idColumn, referenceColumn, schema } from "../../../schema/create";
import { NodePostgresDriverConfig } from "../driver-config";
import { buildQueryTreeWhere } from "./query-tree-where-builder";

describe("query-tree-where-builder", () => {
  const testSchema = schema("test", (s) => {
    return s
      .addTable("users", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("email", column("string"));
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("userId", referenceColumn({ table: "users" }));
      });
  });

  const usersTable = testSchema.tables.users;
  const postsTable = testSchema.tables.posts;

  const createMockEB = () => {
    const mockEB = ((col: string, op: string, val: unknown) => {
      return { type: "compare", col, op, val };
    }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    mockEB.and = (conditions: unknown[]) => {
      return { type: "and", conditions };
    };

    mockEB.or = (conditions: unknown[]) => {
      return { type: "or", conditions };
    };

    mockEB.not = (condition: unknown) => {
      return { type: "not", condition };
    };

    mockEB.ref = (name: string) => {
      return { type: "ref", name };
    };

    mockEB.selectFrom = (tableName: string) => {
      const query = {
        tableName,
        _select: null as string | null,
        _where: null as { col: string; op: string; val: unknown } | null,
        _limit: null as number | null,
        select: (col: string) => {
          query._select = col;
          return query;
        },
        where: (col: string, op: string, val: unknown) => {
          query._where = { col, op, val };
          return query;
        },
        limit: (n: number) => {
          query._limit = n;
          return query;
        },
      };
      return query;
    };

    return mockEB;
  };

  it("compares child reference columns to parent external-id columns through aliases", () => {
    const condition: Condition = {
      type: "compare",
      a: postsTable.columns.userId,
      operator: "=",
      b: new ParentColumnRef(usersTable.columns.id),
    };

    const result = buildQueryTreeWhere(
      condition,
      createMockEB(),
      new NodePostgresDriverConfig(),
      undefined,
      undefined,
      postsTable,
      "post_alias",
      usersTable,
      "user_alias",
    );

    expect(result).toEqual({
      type: "compare",
      col: "post_alias.userId",
      op: "=",
      val: { type: "ref", name: "user_alias._internalId" },
    });
  });

  it("resolves child reference filters by external id string with the child alias", () => {
    const condition: Condition = {
      type: "compare",
      a: postsTable.columns.userId,
      operator: "=",
      b: "user-external-id",
    };

    const result = buildQueryTreeWhere(
      condition,
      createMockEB(),
      new NodePostgresDriverConfig(),
      undefined,
      undefined,
      postsTable,
      "post_alias",
    );

    expect(result).toHaveProperty("type", "compare");
    expect(result).toHaveProperty("col", "post_alias.userId");
    expect(result).toHaveProperty("op", "=");
    const val = (result as unknown as { val: Record<string, unknown> }).val;
    expect(val).toMatchObject({
      tableName: "users",
      _select: "_internalId",
      _where: { col: "id", op: "=", val: "user-external-id" },
      _limit: 1,
    });
  });

  it("resolves mixed child reference lists with the child alias", () => {
    const condition: Condition = {
      type: "compare",
      a: postsTable.columns.userId,
      operator: "in",
      b: [FragnoReference.fromInternal(7n), "external-user"],
    };

    const result = buildQueryTreeWhere(
      condition,
      createMockEB(),
      new NodePostgresDriverConfig(),
      undefined,
      undefined,
      postsTable,
      "post_alias",
    );

    expect(result).toMatchObject({
      type: "or",
      conditions: [
        { type: "compare", col: "post_alias.userId", op: "in", val: [7n] },
        { type: "compare", col: "post_alias.userId", op: "in" },
      ],
    });
    const externalSubquery = (
      result as unknown as { conditions: Array<{ val: Record<string, unknown> }> }
    ).conditions[1]!.val;
    expect(externalSubquery).toMatchObject({
      tableName: "users",
      _select: "_internalId",
      _where: { col: "id", op: "in", val: ["external-user"] },
    });
  });
});
