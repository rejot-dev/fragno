import { describe, expect, it, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { InMemoryLofiAdapter } from "./adapter";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

describe("InMemoryLofiAdapter", () => {
  it("applies outbox entries once and records inbox", async () => {
    const adapter = new InMemoryLofiAdapter({ endpointName: "app", schemas: [appSchema] });

    const first = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    assert(first.applied);

    const query = adapter.createQueryEngine(appSchema);
    const users = await query.find("users", (b) => b.whereIndex("primary"));
    expect(users).toHaveLength(1);
    assert(users[0].name === "Ada");

    const second = await adapter.applyOutboxEntry({
      sourceKey: "app::outbox",
      versionstamp: "vs1",
      uowId: "uow-1",
      mutations: [
        {
          op: "create",
          schema: "app",
          table: "users",
          externalId: "user-1",
          versionstamp: "vs1",
          values: { name: "Ada" },
        },
      ],
    });

    assert(!second.applied);
  });
});
