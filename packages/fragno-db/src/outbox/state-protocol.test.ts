import { describe, expect, it, assert } from "vitest";

import superjson from "superjson";

import type { OutboxEntry, OutboxPayload } from "./outbox";
import {
  createFragnoStateEventType,
  decodeFragnoStateValue,
  projectOutboxEntryToStateEvents,
} from "./state-protocol";

const entryWithPayload = (payload: OutboxPayload): OutboxEntry => ({
  id: { externalId: "outbox-1" } as OutboxEntry["id"],
  versionstamp: "000000000000000000000001",
  uowId: "uow-1",
  payload: superjson.serialize(payload),
  refMap: { "0:authorId": "user-1" },
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
});

describe("Fragno State Protocol projection", () => {
  it("uses a stable collision-free event type", () => {
    assert(
      createFragnoStateEventType({
        schemaName: "comments",
        namespace: null,
        tableName: "comment:history",
      }) === 'fragno:["comments",null,"comment:history"]',
    );
  });

  it("projects transactions into standard change events and preserves rich values", () => {
    const [insert, update, remove] = projectOutboxEntryToStateEvents(
      entryWithPayload({
        version: 1,
        mutations: [
          {
            op: "create",
            schema: "comments",
            schemaName: "comments",
            namespace: "tenant-1",
            table: "comment",
            externalId: "comment-1",
            versionstamp: "000000000000000000000001",
            values: {
              authorId: { __fragno_ref: "0:authorId" },
              createdAt: new Date("2026-07-20T12:00:00.000Z"),
            },
          },
          {
            op: "update",
            schema: "comments",
            schemaName: "comments",
            namespace: "tenant-1",
            table: "comment",
            externalId: "comment-1",
            versionstamp: "000000000000000000000002",
            set: { body: "Updated" },
          },
          {
            op: "delete",
            schema: "comments",
            schemaName: "comments",
            namespace: "tenant-1",
            table: "comment",
            externalId: "comment-2",
            versionstamp: "000000000000000000000003",
          },
        ],
      }),
    );

    expect(insert).toMatchObject({
      type: 'fragno:["comments","tenant-1","comment"]',
      key: "comment-1",
      headers: {
        operation: "insert",
        txid: "uow-1",
        timestamp: "2026-07-20T12:00:00.000Z",
      },
    });
    expect(decodeFragnoStateValue(insert!.value)).toEqual({
      mode: "row",
      value: {
        authorId: "user-1",
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      },
    });

    assert(update?.headers.operation === "update");
    expect(decodeFragnoStateValue(update!.value)).toEqual({
      mode: "patch",
      value: { body: "Updated" },
    });

    expect(remove).toEqual({
      type: 'fragno:["comments","tenant-1","comment"]',
      key: "comment-2",
      headers: {
        operation: "delete",
        txid: "uow-1",
        timestamp: "2026-07-20T12:00:00.000Z",
      },
    });
  });

  it("rejects unresolved database expressions before exposing a stream event", () => {
    const entry = entryWithPayload({
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "comments",
          table: "comment",
          externalId: "comment-1",
          versionstamp: "000000000000000000000001",
          values: { createdAt: { tag: "db-now" } },
        },
      ],
    });

    expect(() => projectOutboxEntryToStateEvents(entry)).toThrow(
      "comments.comment.createdAt contains unresolved DbNow",
    );
  });

  it("rejects unresolved references before exposing a stream event", () => {
    const entry = entryWithPayload({
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "comments",
          table: "comment",
          externalId: "comment-1",
          versionstamp: "000000000000000000000001",
          values: { authorId: { __fragno_ref: "missing" } },
        },
      ],
    });

    expect(() => projectOutboxEntryToStateEvents(entry)).toThrow("Outbox ref missing not found");
  });
});
