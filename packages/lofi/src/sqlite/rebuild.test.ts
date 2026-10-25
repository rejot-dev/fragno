import { assert, describe, expect, it } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { defineLocalProjection } from "../local/projection";
import type { AnyLofiLocalProjection, LofiLocalProjectionRebuild } from "../types";
import { planProjectionRebuilds, registrationsNamingReplica } from "./rebuild";

const sourceSchema = schema("source", (s) =>
  s.addTable("events", (t) => t.addColumn("id", idColumn()).addColumn("kind", column("string"))),
);

const viewsSchema = schema("views", (s) =>
  s
    .addTable("counts", (t) => t.addColumn("id", idColumn()).addColumn("count", column("integer")))
    .addTable("latest", (t) => t.addColumn("id", idColumn()).addColumn("kind", column("string"))),
);

const cacheSchema = schema("cache", (s) =>
  s.addTable("entries", (t) => t.addColumn("id", idColumn()).addColumn("kind", column("string"))),
);

const rebuild = (writes: Array<"counts" | "latest">, version = 1): LofiLocalProjectionRebuild => ({
  version,
  from: [{ schema: sourceSchema, table: "events" }],
  writes: writes.map((table) => ({ schema: viewsSchema, table })),
});

const projection = (name: string | undefined, rebuildOptions?: LofiLocalProjectionRebuild) =>
  defineLocalProjection({ name, rebuild: rebuildOptions, mutate: () => {} });

const plan = (projections: AnyLofiLocalProjection[]) =>
  planProjectionRebuilds({
    schemas: [{ schema: sourceSchema }],
    localSchemas: [{ schema: viewsSchema }, { schema: cacheSchema }],
    projections,
  });

describe("planProjectionRebuilds", () => {
  it("fingerprints a projection by its version, its sources, and its tables' statements", () => {
    const [counts] = plan([projection("counts", rebuild(["counts"]))]);
    assert.strictEqual(counts!.metaKey, "projection:counts");
    expect(JSON.parse(counts!.fingerprint)).toEqual({
      version: 1,
      from: ["events_source"],
      tables: [
        `CREATE TABLE IF NOT EXISTS "counts_views" ("id" TEXT NOT NULL UNIQUE, "count" INTEGER, "_internalId" INTEGER PRIMARY KEY AUTOINCREMENT, "_version" INTEGER NOT NULL DEFAULT 0)`,
      ],
    });
    const [bumped] = plan([projection("counts", rebuild(["counts"], 2))]);
    expect(bumped!.fingerprint).not.toBe(counts!.fingerprint);
  });

  it("refuses declarations a rebuild could not keep apart", () => {
    expect(() => plan([projection(undefined, rebuild(["counts"]))])).toThrow(
      "A rebuildable projection needs a name.",
    );
    expect(() =>
      plan([projection("counts", rebuild(["counts"])), projection("counts", rebuild(["latest"]))]),
    ).toThrow("Rebuildable projection names must be unique: counts");
    expect(() =>
      plan([projection("counts", rebuild(["counts"])), projection("both", rebuild(["counts"]))]),
    ).toThrow("Projections counts and both both write counts_views");
    expect(() =>
      plan([
        projection("misplaced", {
          version: 1,
          from: [{ schema: viewsSchema, table: "counts" }],
          writes: [],
        }),
      ]),
    ).toThrow("Projection misplaced replays views.counts, which is not a registered source table.");
    expect(() =>
      plan([
        projection("misplaced", {
          version: 1,
          from: [],
          writes: [{ schema: sourceSchema, table: "events" }],
        }),
      ]),
    ).toThrow("Projection misplaced writes source.events, which is not a registered local table.");
  });
});

describe("registrationsNamingReplica", () => {
  it("leaves out the local schemas only rebuildable projections write", () => {
    const names = (projections: AnyLofiLocalProjection[]) =>
      registrationsNamingReplica({
        schemas: [{ schema: sourceSchema }],
        localSchemas: [{ schema: viewsSchema }, { schema: cacheSchema }],
        projections,
      }).map(({ schema }) => schema.name);

    expect(names([projection("counts", rebuild(["counts"]))])).toEqual([
      "source",
      "views",
      "cache",
    ]);
    expect(
      names([projection("counts", rebuild(["counts"])), projection("latest", rebuild(["latest"]))]),
    ).toEqual(["source", "cache"]);
  });
});
