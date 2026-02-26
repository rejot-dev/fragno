import { describe, expect, it } from "vitest";
import superjson from "superjson";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import type { OutboxPayload } from "@fragno-dev/db";
import {
  decodeOutboxPayload,
  outboxMutationsToUowOperations,
  resolveOutboxRefs,
  type LofiMutation,
} from "./mod";

describe("outbox utilities", () => {
  it("decodes payloads and enforces schema presence", () => {
    const payload: OutboxPayload = {
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs",
          values: { name: "Ada" },
        },
      ],
    };

    const decoded = decodeOutboxPayload(superjson.serialize(payload));
    expect(decoded).toEqual(payload);

    const missingSchemaPayload = superjson.serialize({
      version: 1,
      mutations: [
        {
          op: "create",
          table: "users",
          externalId: "user-2",
          versionstamp: "vs",
          values: { name: "Grace" },
        },
      ],
    });

    expect(() => decodeOutboxPayload(missingSchemaPayload)).toThrow(
      "Outbox mutation schema is required",
    );

    const emptySchemaPayload = superjson.serialize({
      version: 1,
      mutations: [
        {
          op: "create",
          schema: "",
          table: "users",
          externalId: "user-3",
          versionstamp: "vs",
          values: { name: "Linus" },
        },
      ],
    });

    expect(() => decodeOutboxPayload(emptySchemaPayload)).toThrow(
      "Outbox mutation schema is required",
    );
  });

  it("resolves outbox refs in create values and update sets", () => {
    const createMutation: LofiMutation = {
      op: "create",
      schema: "app",
      table: "users",
      externalId: "user-1",
      versionstamp: "vs",
      values: {
        accountId: { __fragno_ref: "0.accountId" },
        name: "Ada",
      },
    };

    const resolvedCreate = resolveOutboxRefs(createMutation, {
      "0.accountId": "account-1",
    });

    expect(resolvedCreate.values["accountId"]).toBe("account-1");
    expect(resolvedCreate.values["name"]).toBe("Ada");

    const updateMutation: LofiMutation = {
      op: "update",
      schema: "app",
      table: "users",
      externalId: "user-1",
      versionstamp: "vs",
      set: {
        accountId: { __fragno_ref: "1.accountId" },
      },
    };

    const resolvedUpdate = resolveOutboxRefs(updateMutation, {
      "1.accountId": "account-2",
    });

    expect(resolvedUpdate.set["accountId"]).toBe("account-2");

    expect(() =>
      resolveOutboxRefs(createMutation, {
        "0.other": "missing",
      }),
    ).toThrow("Outbox ref 0.accountId not found");
  });

  it("converts outbox mutations into uow operations", () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );

    const mutations: LofiMutation[] = [
      {
        op: "create",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs",
        values: { name: "Ada", _shard: "shard-a" },
      },
      {
        op: "update",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs",
        set: { name: "Grace", _shard: "shard-b" },
      },
      {
        op: "delete",
        schema: "app",
        table: "users",
        externalId: "user-2",
        versionstamp: "vs",
      },
    ];

    const ops = outboxMutationsToUowOperations(mutations, { app: appSchema });

    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({
      type: "create",
      table: "users",
      generatedExternalId: "user-1",
      values: { name: "Ada" },
    });
    expect(ops[1]).toMatchObject({
      type: "update",
      table: "users",
      id: "user-1",
      checkVersion: false,
      set: { name: "Grace" },
    });
    expect(ops[2]).toMatchObject({
      type: "delete",
      table: "users",
      id: "user-2",
      checkVersion: false,
    });

    expect(() => outboxMutationsToUowOperations(mutations, { other: appSchema })).toThrow(
      "Unknown outbox schema: app",
    );
  });
});
