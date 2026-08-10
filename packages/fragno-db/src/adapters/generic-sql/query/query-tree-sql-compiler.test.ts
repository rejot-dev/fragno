import { describe, expect, it } from "vitest";

import { createNamingResolver, suffixNamingStrategy } from "../../../naming/sql-naming";
import type {
  CompiledQueryTreeChildNode,
  CompiledQueryTreeRootNode,
} from "../../../query/unit-of-work/query-tree";
import { QueryTreeFindBuilder } from "../../../query/unit-of-work/query-tree";
import { column, idColumn, schema } from "../../../schema/create";
import { BetterSQLite3DriverConfig, MySQL2DriverConfig } from "../driver-config";
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
  it("compiles cross-schema children through their ordinary correlated index condition", () => {
    const resolver = createNamingResolver(eventSchema, "tenant", suffixNamingStrategy);
    const builder = new QueryTreeFindBuilder(eventSchema, "events", events, "tenant");
    builder.whereIndex("primary").withOutboxMutations();
    const root = builder.build();
    if (root.kind !== "root") {
      throw new Error("Expected a query-tree root.");
    }
    const compiler = new QueryTreeSQLCompiler(
      createColdKysely("sqlite"),
      new BetterSQLite3DriverConfig(),
      undefined,
      resolver,
    );

    const query = compiler.compile(root);

    expect(query.sql.replace(/[ \t]+$/gm, "")).toMatchInlineSnapshot(`
      "select "_fragno_root"."id" as "id", "_fragno_root"."happenedOn" as "happenedOn", "_fragno_root"."createdAt" as "createdAt", "_fragno_root"."_internalId" as "_internalId", "_fragno_root"."_version" as "_version",
                coalesce(
                  (
                    select json_group_array(json("_fragno_agg"."_fragno_item"))
                    from ((select json_object('id', "_fragno__outboxMutations_0"."id", '_internalId', "_fragno__outboxMutations_0"."_internalId", '_version', "_fragno__outboxMutations_0"."_version") as "_fragno_item" from "fragno_db_outbox_mutations" as "_fragno__outboxMutations_0" where ("_fragno__outboxMutations_0"."schema" = ? and "_fragno__outboxMutations_0"."table" = ? and "_fragno__outboxMutations_0"."externalId" = "_fragno_root"."id"))) as _fragno_agg
                  ),
                  json('[]')
                )
               as "$outboxMutations" from "events_tenant" as "_fragno_root""
    `);
    expect(query.parameters).toEqual(["tenant", "events"]);
  });

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
