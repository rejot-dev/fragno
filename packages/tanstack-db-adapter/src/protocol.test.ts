import { describe, expect, it, assert } from "vitest";

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import superjson from "superjson";

import type { OutboxPayload } from "@fragno-dev/db";

import {
  projectFragnoOutboxEntry,
  resolveTargetNamespace,
  type FragnoOutboxEntry,
} from "./protocol";

const appSchema = schema("app", (s) =>
  s
    .addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string")))
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string")),
    )
    .addTable("records", (t) => t.addColumn("id", idColumn()).addColumn("payload", column("json"))),
);

const createSerializedEntry = (
  payload: unknown,
  refMap?: Record<string, string>,
): FragnoOutboxEntry => ({
  versionstamp: "000000000000000000000001",
  uowId: "uow-1",
  payload: superjson.serialize(payload),
  refMap,
});

const createEntry = (payload: OutboxPayload, refMap?: Record<string, string>): FragnoOutboxEntry =>
  createSerializedEntry(payload, refMap);

describe("Fragno outbox protocol", () => {
  it("projects creates into complete rows with the external id", () => {
    const entry = createEntry({
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
    });

    expect(projectFragnoOutboxEntry(entry, { schema: appSchema, table: "users" })).toEqual([
      {
        type: "insert",
        key: "user-1",
        value: { id: "user-1", name: "Ada" },
        metadata: {
          versionstamp: "000000000000000000000001",
          uowId: "uow-1",
        },
      },
    ]);
  });

  it("resolves references and filters unrelated tables", () => {
    const entry = createEntry(
      {
        version: 1,
        mutations: [
          {
            op: "create",
            schema: "app",
            table: "posts",
            externalId: "post-1",
            versionstamp: "000000000000000000000001",
            values: {
              authorId: { __fragno_ref: "0.authorId" },
              title: "Hello",
            },
          },
        ],
      },
      { "0.authorId": "user-1" },
    );

    expect(projectFragnoOutboxEntry(entry, { schema: appSchema, table: "posts" })[0]).toMatchObject(
      {
        type: "insert",
        value: { id: "post-1", authorId: "user-1", title: "Hello" },
      },
    );
    expect(projectFragnoOutboxEntry(entry, { schema: appSchema, table: "users" })).toEqual([]);
  });

  it("preserves reference-shaped values in non-reference columns", () => {
    const payload = { __fragno_ref: "user-authored-json" };
    const entry = createEntry({
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "records",
          externalId: "record-1",
          versionstamp: "000000000000000000000001",
          values: { payload },
        },
      ],
    });

    expect(projectFragnoOutboxEntry(entry, { schema: appSchema, table: "records" })).toEqual([
      expect.objectContaining({ value: { id: "record-1", payload } }),
    ]);
  });

  it("keeps updates partial and deletes key-only", () => {
    const entry = createEntry({
      version: 1,
      mutations: [
        {
          op: "update",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "000000000000000000000001",
          set: { name: "Grace" },
        },
        {
          op: "delete",
          schema: "app",
          table: "users",
          externalId: "user-2",
          versionstamp: "000000000000000000000002",
        },
      ],
    });

    const changes = projectFragnoOutboxEntry(entry, { schema: appSchema, table: "users" });
    expect(changes[0]).toMatchObject({
      type: "update",
      key: "user-1",
      value: { id: "user-1", name: "Grace" },
    });
    expect(changes[1]).toMatchObject({ type: "delete", key: "user-2" });
  });

  it("rejects unsupported payload versions", () => {
    const entry = createSerializedEntry({ version: 2, mutations: [] });

    expect(() => projectFragnoOutboxEntry(entry, { schema: appSchema, table: "users" })).toThrow(
      "Unsupported Fragno outbox payload version: 2.",
    );
  });

  it("rejects unknown mutation operations instead of deleting the row", () => {
    const entry = createSerializedEntry({
      version: 1,
      mutations: [
        {
          op: "upsert",
          schema: "app",
          table: "users",
          externalId: "user-1",
          values: { name: "Ada" },
        },
      ],
    });

    expect(() => projectFragnoOutboxEntry(entry, { schema: appSchema, table: "users" })).toThrow(
      "Unsupported Fragno outbox mutation operation: upsert.",
    );
  });

  it("uses explicit physical namespaces", () => {
    const entry = createEntry({
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "tenant-a",
          namespace: "tenant-a",
          table: "users",
          externalId: "user-1",
          versionstamp: "000000000000000000000001",
          values: { name: "Tenant user" },
        },
      ],
    });

    expect(
      projectFragnoOutboxEntry(entry, {
        schema: appSchema,
        table: "users",
        namespace: "tenant-a",
      }),
    ).toHaveLength(1);
    expect(projectFragnoOutboxEntry(entry, { schema: appSchema, table: "users" })).toEqual([]);
    assert(resolveTargetNamespace({ schema: appSchema, table: "users", namespace: null }) === "");
  });
});
