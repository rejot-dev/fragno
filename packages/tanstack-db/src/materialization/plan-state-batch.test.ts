import { describe, expect, it } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { encodeFragnoStateValue } from "@fragno-dev/db/state-protocol";

import { createFragnoStateSchema } from "../state/fragno-state-schema";
import { createStateRegistry, planStateBatch } from "./plan-state-batch";

const appSchema = schema("materialization_app", (s) =>
  s.addTable("user", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("createdAt", column("timestamp")),
  ),
);

const state = createFragnoStateSchema({ users: { schema: appSchema, table: "user" } });
const registry = createStateRegistry(state);
const eventType = state.users.type;

describe("planStateBatch", () => {
  it("materializes rows and patch updates before returning a plan", () => {
    const plan = planStateBatch({
      registry,
      readRow: () => undefined,
      items: [
        {
          type: eventType,
          key: "user-1",
          value: encodeFragnoStateValue("row", {
            name: "Ada",
            createdAt: new Date("2026-07-20T12:00:00.000Z"),
          }),
          headers: { operation: "insert", txid: "uow-1" },
        },
        {
          type: eventType,
          key: "user-1",
          value: encodeFragnoStateValue("patch", { name: "Ada Lovelace" }),
          headers: { operation: "update", txid: "uow-1" },
        },
      ],
    });

    expect(plan).toMatchObject({ reset: false, txids: ["uow-1"] });
    expect(plan.changes).toEqual([
      {
        type: "put",
        collection: registry.collections.get("users"),
        key: "user-1",
        value: {
          id: "user-1",
          name: "Ada",
          createdAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      },
      {
        type: "put",
        collection: registry.collections.get("users"),
        key: "user-1",
        value: {
          id: "user-1",
          name: "Ada Lovelace",
          createdAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      },
    ]);
  });

  it("fills current static defaults and nullable columns while replaying row events", () => {
    const replaySchema = schema("materialization_replay", (s) =>
      s.addTable("item", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("enabled", column("bool").defaultTo(true))
          .addColumn("note", column("string").nullable()),
      ),
    );
    const replayState = createFragnoStateSchema({
      items: { schema: replaySchema, table: "item" },
    });
    const replayRegistry = createStateRegistry(replayState);

    const plan = planStateBatch({
      registry: replayRegistry,
      readRow: () => undefined,
      items: [
        {
          type: replayState.items.type,
          key: "item-1",
          value: encodeFragnoStateValue("row", { name: "Historical" }),
          headers: { operation: "insert" },
        },
      ],
    });

    expect(plan.changes).toEqual([
      {
        type: "put",
        collection: replayRegistry.collections.get("items"),
        key: "item-1",
        value: { id: "item-1", name: "Historical", enabled: true, note: null },
      },
    ]);
  });

  it("validates the complete batch before returning changes", () => {
    expect(() =>
      planStateBatch({
        registry,
        readRow: () => undefined,
        items: [
          {
            type: eventType,
            key: "user-1",
            value: encodeFragnoStateValue("row", {
              name: "Ada",
              createdAt: new Date("2026-07-20T12:00:00.000Z"),
            }),
            headers: { operation: "insert" },
          },
          {
            type: eventType,
            key: "user-2",
            value: encodeFragnoStateValue("row", {
              name: 42,
              createdAt: new Date("2026-07-20T12:00:00.000Z"),
            }),
            headers: { operation: "insert" },
          },
        ],
      }),
    ).toThrow("Invalid streamed row for user");
  });

  it("supports reset controls and ignores unrelated event types", () => {
    const plan = planStateBatch({
      registry,
      readRow: () => ({
        id: "user-1",
        name: "Existing",
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
      items: [
        {
          type: eventType,
          key: "user-1",
          headers: { operation: "delete" },
        },
        { headers: { control: "reset" } },
        {
          type: "unrelated",
          key: "other-1",
          value: { ignored: true },
          headers: { operation: "insert" },
        },
      ],
    });

    expect(plan).toEqual({ reset: true, changes: [], txids: [] });
  });
});
