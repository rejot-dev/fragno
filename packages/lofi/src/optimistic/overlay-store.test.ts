import { describe, expect, it } from "vitest";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import type { LofiMutation } from "../types";
import { OptimisticOverlayStore } from "./overlay-store";

const createAppSchema = () =>
  schema("app", (s) =>
    s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
  );

const createStore = (appSchema: ReturnType<typeof createAppSchema>) =>
  new OptimisticOverlayStore({ endpointName: "app", schemas: [appSchema] });

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

describe("OptimisticOverlayStore", () => {
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
});
