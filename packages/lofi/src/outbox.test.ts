import { describe, expect, it, assert } from "vitest";

import { column, FragnoId, idColumn, schema } from "@fragno-dev/db/schema";
import superjson from "superjson";

import type { OutboxPayload } from "@fragno-dev/db";

import {
  decodeOutboxPayload,
  outboxMutationsToUowOperations,
  resolveOutboxRefs,
  uowOperationsToLofiMutations,
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

    assert(resolvedCreate.values["accountId"] === "account-1");
    assert(resolvedCreate.values["name"] === "Ada");

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

    assert(resolvedUpdate.set["accountId"] === "account-2");

    expect(() =>
      resolveOutboxRefs(createMutation, {
        "0.other": "missing",
      }),
    ).toThrow("Outbox ref 0.accountId not found");
  });

  it("converts uow operations into lofi mutations", () => {
    const appSchema = schema("app", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );

    const mutations = uowOperationsToLofiMutations([
      {
        type: "create",
        schema: appSchema,
        table: "users",
        generatedExternalId: "user-1",
        values: { name: "Ada" },
      },
      {
        type: "update",
        schema: appSchema,
        table: "users",
        id: "user-1",
        checkVersion: false,
        set: { name: "Grace" },
      },
      {
        type: "delete",
        schema: appSchema,
        table: "users",
        id: "user-2",
        checkVersion: false,
      },
      {
        type: "check",
        schema: appSchema,
        table: "users",
        id: FragnoId.fromExternal("user-3", 1),
      },
    ]);

    expect(mutations).toEqual([
      {
        op: "create",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "uow-001",
        values: { name: "Ada" },
      },
      {
        op: "update",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "uow-002",
        set: { name: "Grace" },
      },
      {
        op: "delete",
        schema: "app",
        table: "users",
        externalId: "user-2",
        versionstamp: "uow-003",
      },
    ]);
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
        values: { name: "Ada" },
      },
      {
        op: "update",
        schema: "app",
        table: "users",
        externalId: "user-1",
        versionstamp: "vs",
        set: { name: "Grace" },
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
