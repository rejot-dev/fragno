import { assert, describe, expect, it } from "vitest";

import { SQLocalKysely } from "sqlocal/kysely";

import { internalSchema } from "../../fragments/internal-fragment";
import { queryEngineSuiteSchema } from "../test-suite/query-engine-schema";
import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { SQLocalDriverConfig } from "./driver-config";
import { SqlAdapter } from "./generic-sql-adapter";

describeQueryEngineSuite({
  name: "generic-sql sqlocal",
  createAdapter: async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlAdapter({ dialect, driverConfig: new SQLocalDriverConfig() });
    return { adapter, close: () => adapter.close() };
  },
  capabilities: {
    constraints: false,
  },
});

describe("generic-sql SQLocal relation values", () => {
  it("roundtrips SQLite BLOB-backed columns inside joined JSON rows", async () => {
    const { dialect } = new SQLocalKysely(":memory:");
    const adapter = new SqlAdapter({ dialect, driverConfig: new SQLocalDriverConfig() });
    const namespace = "query_engine_suite";

    try {
      await adapter.prepareMigrations(internalSchema, "").executeWithDriver(adapter.driver, 0);
      await adapter
        .prepareMigrations(queryEngineSuiteSchema, namespace)
        .executeWithDriver(adapter.driver, 0);
      adapter.registerSchema(queryEngineSuiteSchema, namespace);

      const create = adapter.createUnitOfWork(queryEngineSuiteSchema, namespace, "create-event");
      create.create("users", {
        id: "user-with-event",
        name: "Blob Reader",
        email: "blob-reader@example.com",
        age: null,
      });
      create.create("events", {
        id: "blob-event",
        user_id: "user-with-event",
        name: "BLOB event",
        happened_on: new Date("2026-07-28T00:00:00.000Z"),
        payload: { source: "sqlite" },
        big_score: -42n,
        binary_payload: new Uint8Array([0, 127, 128, 255]),
      });
      assert((await create.executeMutations()).success);

      const [[user]] = await adapter
        .createUnitOfWork(queryEngineSuiteSchema, namespace, "read-event")
        .find("users", (users) =>
          users
            .whereIndex("users_email_idx", (eb) => eb("email", "=", "blob-reader@example.com"))
            .joinMany("events", "events", (events) =>
              events.onIndex("events_user_idx", (eb) => eb("user_id", "=", eb.parent("id"))),
            ),
        )
        .executeRetrieve();

      expect(user.events).toHaveLength(1);
      expect(user.events[0]).toMatchObject({
        payload: { source: "sqlite" },
        big_score: -42n,
      });
      expect(user.events[0]?.binary_payload).toEqual(new Uint8Array([0, 127, 128, 255]));
    } finally {
      await adapter.close();
    }
  });
});
