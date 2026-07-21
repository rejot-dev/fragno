import { describe, expect, expectTypeOf, it, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, createFragmentTestFetcher } from "@fragno-dev/test";

import { createFragnoStateSchema, createFragnoStreamDB } from "./stream-db";

const appSchema = schema("state_protocol_app", (s) =>
  s.addTable("user", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("name", column("string"))
      .addColumn("createdAt", column("timestamp")),
  ),
);

const appFragmentDefinition = defineFragment("state-protocol-app")
  .extend(withDatabase(appSchema))
  .build();

const state = createFragnoStateSchema({
  users: { schema: appSchema, table: "user" },
});

const waitForCondition = async (condition: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("createFragnoStreamDB State Protocol API", () => {
  it("exposes explicitly named collections and consumes the Fragno state projection", async () => {
    const server = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "app",
        instantiate(appFragmentDefinition).withOptions({
          mountRoute: "",
          outbox: { enabled: true },
        }),
      )
      .build();
    const fragment = server.fragments.app.fragment;
    const fetcher = createFragmentTestFetcher(fragment);
    const observedTxids: string[] = [];

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(appSchema).create("user", {
            id: "user-1",
            name: "Ada",
            createdAt: new Date("2026-07-20T12:00:00.000Z"),
          });
        })
        .execute();
    });

    const db = createFragnoStreamDB({
      state,
      streamOptions: {
        url: "http://fragno.test/_internal/outbox/durable/state",
        fetch: fetcher,
      },
      live: false,
      onEvent: (event) => {
        if ("operation" in event.headers && event.headers.txid) {
          observedTxids.push(event.headers.txid);
        }
      },
    });

    try {
      expectTypeOf(db.collections.users.get("user-1")).toMatchTypeOf<
        { id: string; name: string; createdAt: Date } | undefined
      >();

      await db.syncOnce();

      expect(db.collections.users.get("user-1")).toMatchObject({
        id: "user-1",
        name: "Ada",
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      });
      expect(db.offset).not.toBe("-1");
      expect(observedTxids).toHaveLength(1);
      await expect(db.utils.awaitTxId(observedTxids[0]!)).resolves.toBeUndefined();
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("materializes mutations committed after State Protocol catch-up", async () => {
    const server = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "app",
        instantiate(appFragmentDefinition).withOptions({
          mountRoute: "",
          outbox: { enabled: true },
        }),
      )
      .build();
    const fragment = server.fragments.app.fragment;
    const db = createFragnoStreamDB({
      state,
      streamOptions: {
        url: "http://fragno.test/_internal/outbox/durable/state",
        fetch: createFragmentTestFetcher(fragment),
      },
    });

    try {
      await db.preload();
      const previousOffset = db.offset;

      await fragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            forSchema(appSchema).create("user", {
              id: "user-live",
              name: "Live Ada",
              createdAt: new Date("2026-07-20T13:00:00.000Z"),
            });
          })
          .execute();
      });

      await waitForCondition(
        () => db.collections.users.has("user-live") && db.offset !== previousOffset,
        "Expected the live State Protocol consumer to materialize the committed user.",
      );
      expect(db.collections.users.get("user-live")).toMatchObject({ name: "Live Ada" });
    } finally {
      await db.close();
      await server.test.cleanup();
    }
  });

  it("exposes only the State Protocol facade and validates stream source options", async () => {
    expect(() => createFragnoStreamDB({ state } as never)).toThrow(
      "createFragnoStreamDB requires streamOptions or stream",
    );

    const db = createFragnoStreamDB({
      state,
      streamOptions: {
        url: "https://example.com/_internal/outbox/durable/state",
        fetch: async () => new Response("[]"),
      },
      live: false,
    });

    try {
      assert(!("forSchema" in db));
      assert(!("subscribe" in db));
      expect(() =>
        createFragnoStreamDB({
          state,
          stream: db.stream,
          streamOptions: {
            url: "https://example.com/_internal/outbox/durable/state",
          },
        } as never),
      ).toThrow("createFragnoStreamDB accepts either stream or streamOptions, not both");
    } finally {
      await db.close();
    }
  });

  it("does not issue network requests before activation", async () => {
    let requests = 0;
    const db = createFragnoStreamDB({
      state,
      streamOptions: {
        url: "https://example.com/_internal/outbox/durable/state",
        fetch: async () => {
          requests += 1;
          throw new Error("unexpected request");
        },
      },
      live: false,
    });

    try {
      await Promise.resolve();
      expect(requests).toBe(0);
      assert(db.status.status === "idle");
    } finally {
      await db.close();
    }
  });
});
