import { describe, expect, expectTypeOf, it, assert } from "vitest";

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

import { createFragnoStateSchema, type FragnoStreamRow } from "./fragno-state-schema";

const appSchema = schema("state_app", (s) =>
  s
    .addTable("user", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("createdAt", column("timestamp")),
    )
    .addTable("post", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn({ table: "user" }))
        .addColumn("title", column("string")),
    ),
);

describe("createFragnoStateSchema", () => {
  it("creates an upstream-compatible state definition with explicit collection names", () => {
    const state = createFragnoStateSchema({
      users: { schema: appSchema, table: "user" },
      posts: { schema: appSchema, table: "post", namespace: null },
    });

    expect(state.users).toMatchObject({
      type: 'fragno:["state_app","state_app","user"]',
      primaryKey: "id",
      fragno: { schema: appSchema, table: appSchema.tables.user, namespace: "state_app" },
    });
    assert(state.posts.type === 'fragno:["state_app",null,"post"]');
    assert(typeof state.users.insert === "function");

    type UserRow = FragnoStreamRow<typeof appSchema.tables.user>;
    expectTypeOf<UserRow>().toEqualTypeOf<{
      id: string;
      name: string;
      createdAt: Date;
    }>();
  });

  it("rejects duplicate physical event types through the upstream schema boundary", () => {
    expect(() =>
      createFragnoStateSchema({
        users: { schema: appSchema, table: "user" },
        duplicateUsers: { schema: appSchema, table: "user" },
      }),
    ).toThrow("Duplicate event type");
  });
});
