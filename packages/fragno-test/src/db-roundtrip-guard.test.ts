import { describe, expect, it, assert } from "vitest";

import { defineRoute } from "@fragno-dev/core/route";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type DatabaseRequestContext, type TxResult } from "@fragno-dev/db";

import { buildDatabaseFragmentsTest } from "./db-test";

const userSchema = schema("user-roundtrip", (s) => {
  return s.addTable("users", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("email", column("string"))
      .createIndex("idx_users_all", ["id"]);
  });
});

describe("dbRoundtripGuard", () => {
  it("blocks multiple handlerTx().execute() calls by default", async () => {
    const userFragmentDef = defineFragment("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const multiRoundtripRoute = defineRoute({
      method: "POST",
      path: "/multi",
      outputSchema: z.object({ ok: z.boolean() }),
      handler: async function (this: DatabaseRequestContext, _input, { json }) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(userSchema).create("users", {
              name: "User 1",
              email: "user1@example.com",
            }),
          )
          .execute();

        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(userSchema).create("users", {
              name: "User 2",
              email: "user2@example.com",
            }),
          )
          .execute();

        return json({ ok: true });
      },
    });

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "user",
        instantiate(userFragmentDef).withConfig({}).withRoutes([multiRoundtripRoute]),
      )
      .build();

    const response = await fragments.user.callRoute("POST", "/multi");

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.error.code === "DB_ROUNDTRIP_LIMIT_EXCEEDED");
    }

    await test.cleanup();
  });

  it("counts withServiceCalls retrieve roundtrips", async () => {
    const userFragmentDef = defineFragment("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          listUsers: function () {
            return this.serviceTx(userSchema)
              .retrieve((uow) => uow.find("users", (b) => b.whereIndex("primary")))
              .build();
          },
        }),
      )
      .build();

    const serviceRoutesFactory = ({
      services,
    }: {
      services: { listUsers: () => TxResult<unknown, unknown> };
    }) => [
      defineRoute({
        method: "POST",
        path: "/service-multi",
        outputSchema: z.object({ ok: z.boolean() }),
        handler: async function (this: DatabaseRequestContext, _input, { json }) {
          await this.handlerTx()
            .withServiceCalls(() => [services.listUsers()])
            .execute();

          await this.handlerTx()
            .withServiceCalls(() => [services.listUsers()])
            .execute();

          return json({ ok: true });
        },
      }),
    ];

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "user",
        instantiate(userFragmentDef).withConfig({}).withRoutes([serviceRoutesFactory]),
      )
      .build();

    const response = await fragments.user.callRoute("POST", "/service-multi");

    assert(response.type === "error");
    if (response.type === "error") {
      assert(response.error.code === "DB_ROUNDTRIP_LIMIT_EXCEEDED");
    }

    await test.cleanup();
  });

  it("allows retrieve-only then mutate-only when maxRoundtrips is 1", async () => {
    const userFragmentDef = defineFragment("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const splitRoundtripRoute = defineRoute({
      method: "POST",
      path: "/split",
      outputSchema: z.object({ count: z.number() }),
      handler: async function (this: DatabaseRequestContext, _input, { json }) {
        const existing = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(userSchema).find("users", (b) => b.whereIndex("primary")),
          )
          .transformRetrieve(([users]) => users)
          .execute();

        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(userSchema).create("users", {
              name: "User 3",
              email: "user3@example.com",
            }),
          )
          .execute();

        return json({ count: existing.length });
      },
    });

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withDbRoundtripGuard({ maxRoundtrips: 1 })
      .withFragment(
        "user",
        instantiate(userFragmentDef).withConfig({}).withRoutes([splitRoundtripRoute]),
      )
      .build();

    const response = await fragments.user.callRoute("POST", "/split");

    assert(response.type === "json");
    if (response.type === "json") {
      assert(response.data.count === 0);
    }

    await test.cleanup();
  });

  it("does not enforce the guard inside jsonStream callbacks", async () => {
    const userFragmentDef = defineFragment("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const streamRoute = defineRoute({
      method: "GET",
      path: "/stream",
      outputSchema: z.array(z.object({ count: z.number() })),
      handler: async function (this: DatabaseRequestContext, _input, { jsonStream }) {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(userSchema).find("users", (b) => b.whereIndex("primary")),
          )
          .execute();

        return jsonStream(async (stream) => {
          await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(userSchema).find("users", (b) => b.whereIndex("primary")),
            )
            .execute();
          await stream.write({ count: 1 });

          await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(userSchema).find("users", (b) => b.whereIndex("primary")),
            )
            .execute();
          await stream.write({ count: 2 });
        });
      },
    });

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}).withRoutes([streamRoute]))
      .build();

    const response = await fragments.user.callRoute("GET", "/stream");

    assert(response.type === "jsonStream");
    const frames: unknown[] = [];
    if (response.type === "jsonStream") {
      for await (const frame of response.stream) {
        frames.push(frame);
      }
    }
    expect(frames).toEqual([{ count: 1 }, { count: 2 }]);

    await test.cleanup();
  });

  it("does not enforce the guard inside inContext", async () => {
    const userFragmentDef = defineFragment("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}))
      .build();

    const result = await fragments.user.fragment.inContext(
      async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(userSchema).find("users", (b) => b.whereIndex("primary")),
          )
          .execute();

        await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(userSchema).find("users", (b) => b.whereIndex("primary")),
          )
          .execute();

        return "ok";
      },
    );

    expect(result).toBe("ok");

    await test.cleanup();
  });
});
