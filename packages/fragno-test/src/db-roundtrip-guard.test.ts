import { describe, expect, it } from "vitest";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { defineRoute } from "@fragno-dev/core/route";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { withDatabase, type DatabaseRequestContext, type TxResult } from "@fragno-dev/db";
import { z } from "zod";
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
    const userFragmentDef = defineFragment<{}>("user-roundtrip-fragment")
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

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.error.code).toBe("DB_ROUNDTRIP_LIMIT_EXCEEDED");
    }

    await test.cleanup();
  });

  it("counts withServiceCalls retrieve roundtrips", async () => {
    const userFragmentDef = defineFragment<{}>("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(({ defineService }) =>
        defineService({
          listUsers: function () {
            return this.serviceTx(userSchema)
              .retrieve((uow) => uow.find("users"))
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

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.error.code).toBe("DB_ROUNDTRIP_LIMIT_EXCEEDED");
    }

    await test.cleanup();
  });

  it("allows retrieve-only then mutate-only when maxRoundtrips is 1", async () => {
    const userFragmentDef = defineFragment<{}>("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const splitRoundtripRoute = defineRoute({
      method: "POST",
      path: "/split",
      outputSchema: z.object({ count: z.number() }),
      handler: async function (this: DatabaseRequestContext, _input, { json }) {
        const existing = await this.handlerTx()
          .retrieve(({ forSchema }) => forSchema(userSchema).find("users"))
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

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data.count).toBe(0);
    }

    await test.cleanup();
  });

  it("does not enforce the guard inside inContext", async () => {
    const userFragmentDef = defineFragment<{}>("user-roundtrip-fragment")
      .extend(withDatabase(userSchema))
      .providesBaseService(() => ({}))
      .build();

    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("user", instantiate(userFragmentDef).withConfig({}))
      .build();

    const result = await fragments.user.fragment.inContext(async function (
      this: DatabaseRequestContext,
    ) {
      await this.handlerTx()
        .retrieve(({ forSchema }) => forSchema(userSchema).find("users"))
        .execute();

      await this.handlerTx()
        .retrieve(({ forSchema }) => forSchema(userSchema).find("users"))
        .execute();

      return "ok";
    });

    expect(result).toBe("ok");

    await test.cleanup();
  });
});
