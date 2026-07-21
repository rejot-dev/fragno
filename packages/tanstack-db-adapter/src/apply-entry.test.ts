import { describe, expect, it } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";
import superjson from "superjson";

import type { OutboxPayload } from "@fragno-dev/db";

import type { ChangeMessageOrDeleteKeyMessage } from "@tanstack/db";

import { applyFragnoOutboxEntry, type FragnoOutboxApplyControls } from "./apply-entry";
import { FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY } from "./checkpoint";
import type { FragnoCollectionRow, FragnoOutboxEntry } from "./protocol";

const appSchema = schema("app", (s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("posts", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string"))),
);

type User = FragnoCollectionRow<(typeof appSchema.tables)["users"]>;

type AppliedEvent =
  | "begin"
  | "commit"
  | { type: "write"; message: ChangeMessageOrDeleteKeyMessage<User, string> }
  | { type: "metadata"; key: string; value: unknown };

function createEntry(payload: OutboxPayload): FragnoOutboxEntry {
  return {
    versionstamp: "000000000000000000000001",
    uowId: "uow-1",
    payload: superjson.serialize(payload),
  };
}

function createRecordingControls(events: AppliedEvent[]): FragnoOutboxApplyControls<User> {
  return {
    begin() {
      events.push("begin");
    },
    write(message) {
      events.push({ type: "write", message });
    },
    metadata: {
      collection: {
        set(key, value) {
          events.push({ type: "metadata", key, value });
        },
      },
    },
    commit() {
      events.push("commit");
    },
  };
}

describe("applyFragnoOutboxEntry", () => {
  it("writes row changes and the checkpoint in one transaction", () => {
    const events: AppliedEvent[] = [];

    applyFragnoOutboxEntry(
      createEntry({
        version: 1,
        mutations: [
          {
            op: "create",
            schema: "app",
            table: "users",
            externalId: "user-1",
            versionstamp: "000000000000000000000001",
            values: { name: "Ada" },
          },
        ],
      }),
      { schema: appSchema, table: "users" },
      createRecordingControls(events),
    );

    expect(events).toEqual([
      "begin",
      {
        type: "write",
        message: {
          type: "insert",
          value: { id: "user-1", name: "Ada" },
          metadata: {
            versionstamp: "000000000000000000000001",
            uowId: "uow-1",
          },
        },
      },
      {
        type: "metadata",
        key: FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
        value: {
          versionstamp: "000000000000000000000001",
          uowId: "uow-1",
        },
      },
      "commit",
    ]);
  });

  it("commits the checkpoint when the entry belongs to another table", () => {
    const events: AppliedEvent[] = [];

    applyFragnoOutboxEntry(
      createEntry({
        version: 1,
        mutations: [
          {
            op: "create",
            schema: "app",
            table: "posts",
            externalId: "post-1",
            versionstamp: "000000000000000000000001",
            values: { title: "Hello" },
          },
        ],
      }),
      { schema: appSchema, table: "users" },
      createRecordingControls(events),
    );

    expect(events).toEqual([
      "begin",
      {
        type: "metadata",
        key: FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
        value: {
          versionstamp: "000000000000000000000001",
          uowId: "uow-1",
        },
      },
      "commit",
    ]);
  });
});
