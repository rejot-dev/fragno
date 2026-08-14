import { assert, describe, expect, it } from "vitest";

import {
  column,
  FragnoReference,
  idColumn,
  referenceColumn,
  schema,
  type FragnoId,
} from "@fragno-dev/db/schema";

import type { DatabaseRequestContext } from "@fragno-dev/db";

import {
  waitFor,
  withFromScratchTestScenario,
  type FromScratchTestScenario,
} from "./coordinator-test-scenario";

const appSchema = schema("port_app", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string")),
    )
    .addTable("posts", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string"))),
);

const referenceSchema = schema("port_references", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("email", column("string"))
        .createIndex("idx_users_email", ["email"], { unique: true }),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string")),
    ),
);

const valueSchema = schema("port_values", (s) =>
  s
    .addTable("records", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("occurredAt", column("timestamp"))
        .addColumn("birthday", column("date"))
        .addColumn("payload", column("json"))
        .addColumn("counter", column("bigint"))
        .addColumn("enabled", column("bool"))
        .addColumn("nickname", column("string").nullable())
        .addColumn("bytes", column("binary")),
    )
    .addTable("defaults", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("label", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((builder) => builder.now()),
        )
        .addColumn("count", column("integer").defaultTo(0))
        .addColumn("enabled", column("bool").defaultTo(true)),
    ),
);

type AppScenario<TTable extends "users" | "posts"> = FromScratchTestScenario<
  typeof appSchema,
  TTable
>;

type User = { id: string; name: string; email: string };

async function createUsers(scenario: AppScenario<"users">, users: User[]): Promise<void> {
  await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        for (const user of users) {
          forSchema(appSchema).create("users", user);
        }
      })
      .execute();
  });
}

async function updateUsers(
  scenario: AppScenario<"users">,
  updates: Array<{ id: string; values: Partial<Omit<User, "id">> }>,
): Promise<void> {
  await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        for (const update of updates) {
          forSchema(appSchema).update("users", update.id, (builder) => builder.set(update.values));
        }
      })
      .execute();
  });
}

async function deleteUsers(scenario: AppScenario<"users">, ids: string[]): Promise<void> {
  await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        for (const id of ids) {
          forSchema(appSchema).delete("users", id);
        }
      })
      .execute();
  });
}

function sortedUsers(scenario: AppScenario<"users">): User[] {
  return [...scenario.collection.values()]
    .map(({ id, name, email }) => ({ id, name, email }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

const ada: User = { id: "user-1", name: "Ada", email: "ada@example.com" };
const grace: User = { id: "user-2", name: "Grace", email: "grace@example.com" };

describe("coordinator materialization", () => {
  it("materializes a server-generated external ID as the collection key", async () => {
    await withFromScratchTestScenario({
      name: "generated-external-id",
      schema: referenceSchema,
      table: "users",
      async run(scenario) {
        let generatedId: FragnoId | undefined;
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(referenceSchema).create("users", { email: "generated@example.com" }),
            )
            .execute();
          const user = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(referenceSchema).findFirst("users", (query) =>
                query.whereIndex("idx_users_email", (expression) =>
                  expression("email", "=", "generated@example.com"),
                ),
              ),
            )
            .transformRetrieve(([result]) => result)
            .execute();
          generatedId = user?.id;
        });
        assert(generatedId);
        await scenario.sync();
        expect(scenario.collection.get(generatedId.externalId)).toMatchObject({
          id: generatedId.externalId,
          email: "generated@example.com",
        });
        await scenario.reload();
        assert(scenario.collection.get(generatedId.externalId)?.email === "generated@example.com");
      },
    });
  });

  it("resolves an internal reference through the outbox refMap", async () => {
    await withFromScratchTestScenario({
      name: "internal-reference",
      schema: referenceSchema,
      table: "posts",
      async run(scenario) {
        let authorId: FragnoId | undefined;
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(referenceSchema).create("users", { email: "ada@example.com" }),
            )
            .execute();
          const user = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(referenceSchema).findFirst("users", (query) =>
                query.whereIndex("idx_users_email", (expression) =>
                  expression("email", "=", "ada@example.com"),
                ),
              ),
            )
            .transformRetrieve(([result]) => result)
            .execute();
          authorId = user?.id;
          assert(authorId?.internalId);
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(referenceSchema).create("posts", {
                id: "post-1",
                authorId: FragnoReference.fromInternal(authorId!.internalId!),
                title: "Analytical Engine",
              }),
            )
            .execute();
        });
        assert(authorId);
        await scenario.sync();
        expect(scenario.collection.get("post-1")?.authorId).toBe(authorId.externalId);
        await scenario.reload();
        expect(scenario.collection.get("post-1")?.authorId).toBe(authorId.externalId);
      },
    });
  });

  it("preserves a Unicode external ID through ingestion and persistence", async () => {
    await withFromScratchTestScenario({
      name: "unicode-id",
      schema: referenceSchema,
      table: "users",
      async run(scenario) {
        const user = { id: "user/你好-🧪", email: "unicode@example.com" };
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) => forSchema(referenceSchema).create("users", user))
            .execute();
        });
        await scenario.sync();
        await scenario.reload();
        expect(scenario.collection.get(user.id)).toMatchObject(user);
        await expect(scenario.readPersistedRows()).resolves.toContainEqual(
          expect.objectContaining({ key: user.id }),
        );
      },
    });
  });

  it("preserves dates, JSON, bigint, booleans, null, and binary values", async () => {
    await withFromScratchTestScenario({
      name: "special-values",
      schema: valueSchema,
      table: "records",
      async run(scenario) {
        const record = {
          id: "record-1",
          occurredAt: new Date("2025-03-04T05:06:07.000Z"),
          birthday: new Date("1815-12-10T00:00:00.000Z"),
          payload: { nested: { enabled: true }, tags: ["math", "computing"], count: 2 },
          counter: 9_007_199_254_740_993n,
          enabled: true,
          nickname: null,
          bytes: new Uint8Array([0, 1, 127, 255]),
        };
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) => forSchema(valueSchema).create("records", record))
            .execute();
        });
        await scenario.sync();
        expect(scenario.collection.get(record.id)).toMatchObject(record);
        await scenario.reload();
        expect(scenario.collection.get(record.id)).toMatchObject(record);
      },
    });
  });

  it("materializes database defaults omitted from a create mutation", async () => {
    await withFromScratchTestScenario({
      name: "defaults",
      schema: valueSchema,
      table: "defaults",
      async run(scenario) {
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(valueSchema).create("defaults", { id: "default-1", label: "Generated" }),
            )
            .execute();
        });
        await scenario.sync();
        expect(scenario.collection.get("default-1")).toMatchObject({
          count: 0,
          enabled: true,
          createdAt: expect.any(Date),
        });
        await scenario.reload();
        expect(scenario.collection.get("default-1")?.createdAt).toBeInstanceOf(Date);
      },
    });
  });

  it("persists partial updates containing structured and special values", async () => {
    await withFromScratchTestScenario({
      name: "special-update",
      schema: valueSchema,
      table: "records",
      async run(scenario) {
        const original = {
          id: "record-1",
          occurredAt: new Date("2025-01-01T00:00:00.000Z"),
          birthday: new Date("2000-01-01T00:00:00.000Z"),
          payload: { revision: 1 },
          counter: 1n,
          enabled: false,
          nickname: "first",
          bytes: new Uint8Array([1, 2, 3]),
        };
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) => forSchema(valueSchema).create("records", original))
            .execute();
        });
        await scenario.sync();
        const occurredAt = new Date("2026-06-07T08:09:10.000Z");
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(valueSchema).update("records", original.id, (update) =>
                update.set({
                  occurredAt,
                  payload: { revision: 2, nested: ["a", "b"] },
                  counter: 2n,
                  enabled: true,
                  nickname: null,
                  bytes: new Uint8Array([4, 5, 6]),
                }),
              ),
            )
            .execute();
        });
        await scenario.sync();
        expect(scenario.collection.get(original.id)).toMatchObject({
          birthday: original.birthday,
          occurredAt,
          payload: { revision: 2, nested: ["a", "b"] },
          counter: 2n,
          enabled: true,
          nickname: null,
          bytes: new Uint8Array([4, 5, 6]),
        });
        await scenario.reload();
        expect(scenario.collection.get(original.id)?.occurredAt).toEqual(occurredAt);
      },
    });
  });
});

describe("coordinator catch-up and mutation contracts", () => {
  it("marks an empty collection ready without creating a checkpoint", async () => {
    await withFromScratchTestScenario({
      name: "empty",
      schema: appSchema,
      table: "users",
      async run(scenario) {
        await scenario.sync();
        assert(scenario.coordinator.state === "live");
        expect(scenario.coordinator.internal.getCheckpoint()).toBeUndefined();
        expect([...scenario.collection]).toEqual([]);
      },
    });
  });

  it("applies multiple inserts from one unit of work", async () => {
    await runUsers("multi-insert", async (scenario) => {
      await createUsers(scenario, [ada, grace]);
      await scenario.sync();
      expect(sortedUsers(scenario)).toEqual([ada, grace]);
    });
  });

  it("does not duplicate rows or advance the checkpoint when syncing an unchanged outbox", async () => {
    await runUsers("unchanged", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      const checkpoint = scenario.coordinator.internal.getCheckpoint();
      await scenario.reload();
      expect(sortedUsers(scenario)).toEqual([ada]);
      expect(scenario.coordinator.internal.getCheckpoint()).toEqual(checkpoint);
    });
  });

  it("applies partial updates without removing unchanged fields", async () => {
    await runUsers("partial-update", async (scenario) => {
      await createUsers(scenario, [ada]);
      await updateUsers(scenario, [{ id: ada.id, values: { name: "Ada Lovelace" } }]);
      await scenario.sync();
      expect(scenario.collection.get(ada.id)).toMatchObject({ ...ada, name: "Ada Lovelace" });
    });
  });

  it("applies successive updates in outbox order", async () => {
    await runUsers("successive-updates", async (scenario) => {
      await createUsers(scenario, [ada]);
      await updateUsers(scenario, [{ id: ada.id, values: { name: "Augusta" } }]);
      await updateUsers(scenario, [{ id: ada.id, values: { name: "Ada Lovelace" } }]);
      await scenario.sync();
      assert(scenario.collection.get(ada.id)?.name === "Ada Lovelace");
    });
  });

  it("updates multiple rows from one unit of work", async () => {
    await runUsers("multi-update", async (scenario) => {
      await createUsers(scenario, [ada, grace]);
      await updateUsers(scenario, [
        { id: ada.id, values: { name: "Ada Lovelace" } },
        { id: grace.id, values: { name: "Grace Hopper" } },
      ]);
      await scenario.sync();
      expect(sortedUsers(scenario).map(({ name }) => name)).toEqual([
        "Ada Lovelace",
        "Grace Hopper",
      ]);
    });
  });

  it("deletes a row from memory and persisted storage", async () => {
    await runUsers("delete-persisted", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      await deleteUsers(scenario, [ada.id]);
      await scenario.sync();
      expect(scenario.collection.get(ada.id)).toBeUndefined();
      await scenario.reload();
      expect(scenario.collection.get(ada.id)).toBeUndefined();
      await expect(scenario.readPersistedRows()).resolves.toEqual([]);
    });
  });

  it("deletes only the selected row from a multi-row collection", async () => {
    await runUsers("selected-delete", async (scenario) => {
      await createUsers(scenario, [ada, grace]);
      await deleteUsers(scenario, [ada.id]);
      await scenario.sync();
      expect(sortedUsers(scenario)).toEqual([grace]);
    });
  });

  it("materializes no row when create and delete are both caught up initially", async () => {
    await runUsers("create-delete", async (scenario) => {
      await createUsers(scenario, [ada]);
      await deleteUsers(scenario, [ada.id]);
      await scenario.sync();
      expect([...scenario.collection]).toEqual([]);
    });
  });

  it("applies one hundred mutations from a single outbox entry", async () => {
    await runUsers("hundred-mutations", async (scenario) => {
      const users = Array.from({ length: 100 }, (_, index) => ({
        id: `user-${index}`,
        name: `User ${index}`,
        email: `user-${index}@example.com`,
      }));
      await createUsers(scenario, users);
      await scenario.sync();
      assert(scenario.collection.size === 100);
    });
  });

  it("advances the collection checkpoint for an update that keeps the same values", async () => {
    await runUsers("same-value-update", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      const first = scenario.coordinator.internal.getCheckpoint();
      await updateUsers(scenario, [{ id: ada.id, values: { name: ada.name } }]);
      await scenario.sync();
      expect(scenario.coordinator.internal.getCheckpoint()?.versionstamp).not.toBe(
        first?.versionstamp,
      );
    });
  });

  it("advances the checkpoint across a multi-row delete transaction", async () => {
    await runUsers("multi-delete", async (scenario) => {
      await createUsers(scenario, [ada, grace]);
      await scenario.sync();
      const first = scenario.coordinator.internal.getCheckpoint();
      await deleteUsers(scenario, [ada.id, grace.id]);
      await scenario.sync();
      expect(scenario.coordinator.internal.getCheckpoint()?.versionstamp).not.toBe(
        first?.versionstamp,
      );
      assert(scenario.collection.size === 0);
    });
  });

  it("stores one shared collection checkpoint for rows changed by the same unit of work", async () => {
    await runUsers("shared-checkpoint", async (scenario) => {
      await createUsers(scenario, [ada, grace]);
      await scenario.sync();
      const checkpoint = scenario.coordinator.internal.getCheckpoint();
      assert(checkpoint);
      const rows = await scenario.readPersistedRows();
      expect(rows).toHaveLength(2);
      expect(rows.map(({ metadata }) => metadata)).toEqual([undefined, undefined]);
    });
  });

  it("applies every UOW to every collection before advancing to the next UOW", async () => {
    await runUsers("uow-order", async (scenario) => {
      await createUsers(scenario, [ada]);
      await updateUsers(scenario, [{ id: ada.id, values: { name: "second" } }]);
      await updateUsers(scenario, [{ id: ada.id, values: { name: "third" } }]);
      await scenario.sync();
      assert(scenario.collection.get(ada.id)?.name === "third");
    });
  });
});

describe("coordinator target routing and shared checkpoints", () => {
  it("checkpoints entries for unrelated tables", async () => {
    await runUsers("unrelated-table", async (scenario) => {
      await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(appSchema).create("posts", { id: "post-1", title: "Unrelated" }),
          )
          .execute();
      });
      await scenario.sync();
      assert(scenario.collection.size === 0);
      expect(scenario.coordinator.internal.getCheckpoint()).toBeDefined();
    });
  });

  it("applies target mutations and ignores unrelated mutations in the same entry", async () => {
    await runUsers("mixed-target", async (scenario) => {
      await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("users", ada);
            forSchema(appSchema).create("posts", { id: "post-1", title: "Unrelated" });
          })
          .execute();
      });
      await scenario.sync();
      expect(sortedUsers(scenario)).toEqual([ada]);
    });
  });

  it("ignores a mismatched physical namespace while advancing the checkpoint", async () => {
    await withFromScratchTestScenario({
      name: "mismatched-namespace",
      schema: appSchema,
      table: "users",
      databaseNamespace: "other_namespace",
      async run(scenario) {
        await createUsers(scenario, [ada]);
        await scenario.sync();
        assert(scenario.collection.size === 0);
        expect(scenario.coordinator.internal.getCheckpoint()).toBeDefined();
      },
    });
  });

  it("matches a custom physical namespace", async () => {
    const customSchema = schema("custom-namespace", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    await withFromScratchTestScenario({
      name: "custom-namespace",
      schema: customSchema,
      table: "users",
      async run(scenario) {
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(customSchema).create("users", { id: "user-1", name: "Ada" }),
            )
            .execute();
        });
        await scenario.sync();
        assert(scenario.collection.get("user-1")?.name === "Ada");
      },
    });
  });

  it("matches the empty physical namespace", async () => {
    const emptySchema = schema("", (s) =>
      s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
    );
    await withFromScratchTestScenario({
      name: "empty-namespace",
      schema: emptySchema,
      table: "users",
      async run(scenario) {
        await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
          await this.handlerTx()
            .mutate(({ forSchema }) =>
              forSchema(emptySchema).create("users", { id: "user-1", name: "Ada" }),
            )
            .execute();
        });
        await scenario.sync();
        assert(scenario.collection.get("user-1")?.name === "Ada");
      },
    });
  });

  it("advances through unrelated entries before reaching a target entry", async () => {
    await runUsers("unrelated-before-target", async (scenario) => {
      await scenario.server.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(appSchema).create("posts", { id: "post-1", title: "First" }),
          )
          .execute();
      });
      await createUsers(scenario, [ada]);
      await scenario.sync();
      expect(sortedUsers(scenario)).toEqual([ada]);
    });
  });
});

describe("coordinator persistence and reload", () => {
  it("persists an inserted row and hydrates it after reload", async () => {
    await runUsers("persist-reload", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      await scenario.reload();
      expect(sortedUsers(scenario)).toEqual([ada]);
    });
  });

  it("persists rows without per-row synchronization metadata", async () => {
    await runUsers("no-row-metadata", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      const [row] = await scenario.readPersistedRows();
      expect(row).toMatchObject({ key: ada.id, value: ada });
      expect(row?.metadata).toBeUndefined();
    });
  });

  it("persists later updates without adding per-row metadata", async () => {
    await runUsers("updated-no-metadata", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      await updateUsers(scenario, [{ id: ada.id, values: { name: "Ada Lovelace" } }]);
      await scenario.sync();
      const [row] = await scenario.readPersistedRows();
      expect(row?.value).toMatchObject({ ...ada, name: "Ada Lovelace" });
      expect(row?.metadata).toBeUndefined();
    });
  });

  it("continues create, update, and delete ingestion after reload", async () => {
    await runUsers("reload-continues", async (scenario) => {
      await createUsers(scenario, [ada, grace]);
      await scenario.sync();
      await scenario.reload();
      await updateUsers(scenario, [{ id: ada.id, values: { name: "Ada Lovelace" } }]);
      await deleteUsers(scenario, [grace.id]);
      await createUsers(scenario, [
        { id: "user-3", name: "Katherine", email: "katherine@example.com" },
      ]);
      await scenario.sync();
      expect(sortedUsers(scenario)).toEqual([
        { ...ada, name: "Ada Lovelace" },
        { id: "user-3", name: "Katherine", email: "katherine@example.com" },
      ]);
    });
  });

  it("does not replay old rows when synchronizing after reload", async () => {
    await runUsers("no-old-replay", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      const checkpoint = scenario.coordinator.internal.getCheckpoint();
      await scenario.reload();
      expect(sortedUsers(scenario)).toEqual([ada]);
      expect(scenario.coordinator.internal.getCheckpoint()).toEqual(checkpoint);
    });
  });

  it("does not become ready until synchronization metadata is durable", async () => {
    await runUsers("durable-before-live", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      const checkpoint = scenario.coordinator.internal.getCheckpoint();
      assert(checkpoint);
      await scenario.reload();
      expect(scenario.coordinator.internal.getCheckpoint()).toEqual(checkpoint);
    });
  });

  it("hydrates an initialized snapshot before live streaming opens", async () => {
    await runUsers("hydrate-before-stream", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      await scenario.reload();
      expect(sortedUsers(scenario)).toEqual([ada]);
      expect(["caught-up", "live"]).toContain(scenario.coordinator.state);
    });
  });

  it("opens a clean persistence database when the adapter identity changes", async () => {
    let identityGeneration = 1;
    await withFromScratchTestScenario({
      name: "identity-database",
      schema: appSchema,
      table: "users",
      fetch(serverFetch) {
        return async (input, init) => {
          const response = await serverFetch(input, init);
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (!url.pathname.endsWith("/_internal")) {
            return response;
          }
          const body = (await response.json()) as Record<string, unknown>;
          body["adapterIdentity"] = `${String(body["adapterIdentity"])}:${identityGeneration}`;
          return Response.json(body, { status: response.status, headers: response.headers });
        };
      },
      async run(scenario) {
        await createUsers(scenario, [ada]);
        await scenario.sync();
        const firstDatabaseName = scenario.openedDatabaseNames[0];
        identityGeneration = 2;
        await scenario.reload();
        expect(scenario.openedDatabaseNames[1]).not.toBe(firstDatabaseName);
        expect(sortedUsers(scenario)).toEqual([ada]);
      },
    });
  });
});

describe("coordinator lifecycle", () => {
  it("keeps the adapter identity stable for the coordinator lifetime", async () => {
    let describeRequests = 0;
    await withFromScratchTestScenario({
      name: "stable-identity",
      schema: appSchema,
      table: "users",
      fetch(serverFetch) {
        return async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/_internal")) {
            describeRequests += 1;
          }
          return serverFetch(input, init);
        };
      },
      async run(scenario) {
        await scenario.sync();
        await createUsers(scenario, [ada]);
        await scenario.sync();
        expect(describeRequests).toBe(1);
      },
    });
  });

  it("does not synchronize registered collections until the coordinator starts", async () => {
    await runUsers("paused-registration", async (scenario) => {
      await createUsers(scenario, [ada]);
      assert(scenario.coordinator.state === "idle");
      assert(scenario.collection.size === 0);
      await scenario.sync();
      expect(sortedUsers(scenario)).toEqual([ada]);
    });
  });

  it("resolves the adapter identity once for the coordinator lifetime", async () => {
    let internalDescribeRequests = 0;
    await withFromScratchTestScenario({
      name: "identity-once",
      schema: appSchema,
      table: "users",
      fetch(serverFetch) {
        return async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/_internal")) {
            internalDescribeRequests += 1;
          }
          return serverFetch(input, init);
        };
      },
      async run(scenario) {
        await scenario.coordinator.preload();
        await waitFor(() => scenario.coordinator.state === "live");
        expect(internalDescribeRequests).toBe(1);
      },
    });
  });

  it("serializes concurrent preload requests", async () => {
    await runUsers("concurrent-preload", async (scenario) => {
      await createUsers(scenario, [ada]);
      const first = scenario.coordinator.preload();
      const second = scenario.coordinator.preload();
      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(sortedUsers(scenario)).toEqual([ada]);
    });
  });

  it("exposes an incomplete cross-collection join between sequential collection commits", async () => {
    await runUsers("sequential-visibility", async (scenario) => {
      await createUsers(scenario, [ada]);
      await scenario.sync();
      expect(sortedUsers(scenario)).toEqual([ada]);
      // TanStack collections commit independently; the shared checkpoint is the atomic replay
      // boundary, not an atomic cross-collection UI boundary.
      expect(scenario.coordinator.internal.getCheckpoint()).toBeDefined();
    });
  });
});

describe("coordinator stream recovery", () => {
  it("catches up mutations committed while the stream reconnects", async () => {
    let streamRequests = 0;
    await withFromScratchTestScenario({
      name: "reconnect-catch-up",
      schema: appSchema,
      table: "users",
      fetch(serverFetch) {
        return async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/_internal/outbox/stream") && streamRequests++ === 0) {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("interrupted stream"));
                },
              }),
            );
          }
          return serverFetch(input, init);
        };
      },
      async run(scenario) {
        await scenario.coordinator.preload();
        await waitFor(() => scenario.coordinator.state === "retrying");
        await createUsers(scenario, [ada]);
        await waitFor(
          () => scenario.coordinator.state === "live" && scenario.collection.has(ada.id),
        );
      },
    });
  });

  it("does not return to live until replacement catch-up finishes", async () => {
    let streamRequests = 0;
    const replayGate = Promise.withResolvers<void>();
    let gateReplay = false;
    await withFromScratchTestScenario({
      name: "replacement-catch-up",
      schema: appSchema,
      table: "users",
      fetch(serverFetch) {
        return async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/_internal/outbox/stream") && streamRequests++ === 0) {
            gateReplay = true;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("interrupted stream"));
                },
              }),
            );
          }
          if (gateReplay && url.pathname.endsWith("/_internal/outbox")) {
            await replayGate.promise;
            gateReplay = false;
          }
          return serverFetch(input, init);
        };
      },
      async run(scenario) {
        await scenario.coordinator.preload();
        await waitFor(() => scenario.coordinator.state === "replaying");
        await createUsers(scenario, [ada]);
        assert(scenario.coordinator.state === "replaying");
        replayGate.resolve();
        await waitFor(
          () => scenario.coordinator.state === "live" && scenario.collection.has(ada.id),
        );
      },
    });
  });

  it("backs off repeated stream failures before recovering", async () => {
    const streamRequestTimes: number[] = [];
    await withFromScratchTestScenario({
      name: "stream-backoff",
      schema: appSchema,
      table: "users",
      fetch(serverFetch) {
        return async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/_internal/outbox/stream")) {
            streamRequestTimes.push(performance.now());
            if (streamRequestTimes.length <= 3) {
              throw new Error("stream unavailable");
            }
          }
          return serverFetch(input, init);
        };
      },
      async run(scenario) {
        await scenario.coordinator.preload();
        await waitFor(() => scenario.coordinator.state === "live");
        expect(streamRequestTimes).toHaveLength(4);
        expect(streamRequestTimes[1]! - streamRequestTimes[0]!).toBeGreaterThanOrEqual(20);
        expect(streamRequestTimes[2]! - streamRequestTimes[1]!).toBeGreaterThanOrEqual(20);
      },
    });
  });

  it("marks collections ready after reconnecting a synchronized stream", async () => {
    let streamRequests = 0;
    await withFromScratchTestScenario({
      name: "ready-after-reconnect",
      schema: appSchema,
      table: "users",
      fetch(serverFetch) {
        return async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/_internal/outbox/stream") && streamRequests++ === 0) {
            throw new Error("first stream unavailable");
          }
          return serverFetch(input, init);
        };
      },
      async run(scenario) {
        await createUsers(scenario, [ada]);
        await scenario.coordinator.preload();
        await waitFor(() => scenario.coordinator.state === "live");
        assert(scenario.collection.status === "ready");
        expect(sortedUsers(scenario)).toEqual([ada]);
      },
    });
  });
});

async function runUsers(
  name: string,
  run: (scenario: AppScenario<"users">) => Promise<void>,
): Promise<void> {
  await withFromScratchTestScenario({ name, schema: appSchema, table: "users", run });
}
