import { describe, expect, it } from "vitest";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import type { LofiMutation } from "../../types";
import { InMemoryLofiStore } from "./store";

const createAppSchema = () =>
  schema("app", (s) =>
    s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
  );

const createShardSchema = () =>
  schema("app", (s) =>
    s.addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("_shard", column("string").hidden()),
    ),
  );

const createStore = (
  appSchema: ReturnType<typeof createAppSchema> | ReturnType<typeof createShardSchema>,
) => new InMemoryLofiStore({ endpointName: "app", schemas: [appSchema] });

const createMutation = (name: string): LofiMutation => ({
  op: "create",
  schema: "app",
  table: "users",
  externalId: "user-1",
  versionstamp: "vs-1",
  values: { name },
});

const updateMutation = (name: string): LofiMutation => ({
  op: "update",
  schema: "app",
  table: "users",
  externalId: "user-1",
  versionstamp: "vs-2",
  set: { name },
});

describe("InMemoryLofiStore", () => {
  it("rebuilds optimistic state after reload by reapplying queued mutations", () => {
    const appSchema = createAppSchema();
    const baseStore = createStore(appSchema);

    baseStore.applyMutation(createMutation("Ada"));
    const baseRows = baseStore.getTableRows("app", "users");

    const optimisticStore = createStore(appSchema);
    optimisticStore.seedRows(baseRows);
    optimisticStore.applyMutation(updateMutation("Bea"));
    const optimisticRow = optimisticStore.getRow("app", "users", "user-1");

    const reloadedStore = createStore(appSchema);
    reloadedStore.seedRows(baseRows);
    reloadedStore.applyMutation(updateMutation("Bea"));
    const reloadedRow = reloadedStore.getRow("app", "users", "user-1");

    expect(reloadedRow).toEqual(optimisticRow);
    expect(reloadedRow?._lofi.version).toBe(2);
    expect(reloadedRow?.data["name"]).toBe("Bea");
  });

  it("tracks tombstones for deletes and clears them on create", () => {
    const appSchema = createAppSchema();
    const store = createStore(appSchema);

    store.applyMutation(createMutation("Ada"));
    store.applyMutation({
      op: "delete",
      schema: "app",
      table: "users",
      externalId: "user-1",
      versionstamp: "vs-3",
    });

    expect(store.getRow("app", "users", "user-1")).toBeUndefined();
    expect(store.hasTombstone("app", "users", "user-1")).toBe(true);

    store.applyMutation(createMutation("Bea"));
    expect(store.hasTombstone("app", "users", "user-1")).toBe(false);
  });

  it("ignores _shard system values in mutations", () => {
    const appSchema = createShardSchema();
    const store = createStore(appSchema);

    store.applyMutation({
      op: "create",
      schema: "app",
      table: "users",
      externalId: "user-1",
      versionstamp: "vs-1",
      values: { name: "Ada", _shard: "shard-a" },
    });

    store.applyMutation({
      op: "update",
      schema: "app",
      table: "users",
      externalId: "user-1",
      versionstamp: "vs-2",
      set: { name: "Bea", _shard: "shard-b" },
    });

    const row = store.getRow("app", "users", "user-1");
    expect(row?.data).not.toHaveProperty("_shard");
    expect(row?._lofi.norm["_shard"]).toBeUndefined();
  });
});
