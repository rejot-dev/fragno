import { describe, expect, it, assert } from "vitest";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import { column, idColumn, schema } from "../../schema/create";
import { isParentColumnRef, QueryTreeFindBuilder } from "./query-tree";

const sourceSchema = schema("query_tree_outbox_source", (s) =>
  s.addTable("events", (t) =>
    t.addColumn("eventId", idColumn()).addColumn("scope", column("string")),
  ),
);

describe("QueryTreeFindBuilder.withOutboxMutations", () => {
  it("describes the outbox lookup as an indexed cross-schema correlated child", () => {
    const events = sourceSchema.tables.events;
    const builder = new QueryTreeFindBuilder(sourceSchema, "events", events, "tenant");

    builder.whereIndex("primary").withOutboxMutations();
    const root = builder.build();

    assert(root.kind === "root");
    if (root.kind !== "root") {
      throw new Error("Expected a query-tree root.");
    }

    const child = root.children[0];
    expect(child).toMatchObject({
      kind: "child",
      alias: "$outboxMutations",
      schema: internalSchema,
      namespace: null,
      table: internalSchema.tables.fragno_db_outbox_mutations,
      cardinality: "many",
      onIndexName: "idx_outbox_mutations_key",
      select: ["id"],
      children: [],
    });
    expect(child?.onIndex).toMatchObject({
      type: "and",
      items: [
        { type: "compare", a: expect.objectContaining({ name: "schema" }), b: "tenant" },
        { type: "compare", a: expect.objectContaining({ name: "table" }), b: "events" },
        {
          type: "compare",
          a: expect.objectContaining({ name: "externalId" }),
        },
      ],
    });

    const externalIdComparison =
      child?.onIndex?.type === "and" ? child.onIndex.items[2] : undefined;
    assert(externalIdComparison?.type === "compare");
    if (externalIdComparison?.type !== "compare") {
      throw new Error("Expected an external-ID correlation.");
    }
    assert(isParentColumnRef(externalIdComparison.b));
    if (!isParentColumnRef(externalIdComparison.b)) {
      throw new Error("Expected a parent column reference.");
    }
    expect(externalIdComparison.b.column).toBe(events.columns.eventId);
  });

  it("uses the empty namespace for an unnamespaced source schema", () => {
    const events = sourceSchema.tables.events;
    const builder = new QueryTreeFindBuilder(sourceSchema, "events", events, null);

    builder.whereIndex("primary").withOutboxMutations();
    const root = builder.build();

    if (root.kind !== "root") {
      throw new Error("Expected a query-tree root.");
    }
    const onIndex = root.children[0]?.onIndex;
    assert(onIndex?.type === "and");
    if (onIndex?.type !== "and") {
      throw new Error("Expected an indexed outbox correlation.");
    }
    expect(onIndex.items[0]).toMatchObject({ type: "compare", b: "" });
  });
});
