import { describe, expect, it } from "vitest";

import type {
  CompiledQueryTreeChildNode,
  CompiledQueryTreeRootNode,
} from "../../../query/unit-of-work/query-tree";
import { column, idColumn, schema } from "../../../schema/create";
import { MySQL2DriverConfig } from "../driver-config";
import { createColdKysely } from "../migration/cold-kysely";
import { QueryTreeSQLCompiler } from "./query-tree-sql-compiler";

const eventSchema = schema("query_tree_date_projection", (s) =>
  s.addTable("events", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("happenedOn", column("date"))
      .addColumn("createdAt", column("timestamp")),
  ),
);

const events = eventSchema.tables.events;

describe("QueryTreeSQLCompiler", () => {
  it("projects MySQL DATE values in root and JSON child selections", () => {
    const child: CompiledQueryTreeChildNode = {
      kind: "child",
      alias: "relatedEvent",
      table: events,
      cardinality: "one",
      onIndexName: "primary",
      select: ["happenedOn", "createdAt"],
      children: [],
    };
    const root: CompiledQueryTreeRootNode = {
      kind: "root",
      table: events,
      useIndex: "primary",
      select: ["happenedOn", "createdAt"],
      children: [child],
    };
    const compiler = new QueryTreeSQLCompiler(createColdKysely("mysql"), new MySQL2DriverConfig());

    const query = compiler.compile(root);

    expect(query.sql).toContain("cast(`_fragno_root`.`happenedOn` as char) as `happenedOn`");
    expect(query.sql).toContain("cast(`_fragno_relatedEvent_0`.`happenedOn` as char)");
    expect(query.sql).toContain("`_fragno_root`.`createdAt` as `createdAt`");
    expect(query.sql).not.toContain("cast(`_fragno_root`.`createdAt` as char)");
  });
});
