import { Kysely, PostgresDialect } from "kysely";
import { describe, it, beforeAll, assert, expect } from "vitest";
import { column, idColumn, referenceColumn, schema } from "../../schema/create";
import type { Kysely as KyselyType } from "kysely";
import { createKyselyQueryCompiler } from "./kysely-query-compiler";

describe("query-builder-joins", () => {
  const userSchema = schema((s) => {
    return s
      .addTable("users", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      })
      .addTable("posts", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("title", column("string"))
          .addColumn("userId", referenceColumn());
      })
      .addTable("tags", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      })
      .addReference("posts", "author", {
        columns: ["userId"],
        targetTable: "users",
        targetColumns: ["id"],
      });
  });

  let kysely: KyselyType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fake Postgres connection information
    kysely = new Kysely({ dialect: new PostgresDialect({} as any) });
  });

  describe("postgresql", () => {
    it("should compile select with join condition comparing columns", () => {
      const compiler = createKyselyQueryCompiler(userSchema, {
        db: kysely,
        provider: "postgresql",
      });

      const query = compiler.findMany("posts", {
        select: ["id", "userId"],
        join: (b) => b.author(),
      });

      assert(query);
      expect(query.sql).toMatchSnapshot();
    });
  });
});
