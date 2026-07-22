import { assert, describe, expect, it } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import type { DatabaseRequestContext } from "@fragno-dev/db";
import { withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, createFragmentTestFetcher } from "@fragno-dev/test";

import { createCollection } from "@tanstack/db";

import { fragnoCollectionOptions } from "./collection-options";
import { createFragnoOutboxCoordinator, type FragnoOutboxBootstrap } from "./coordinator";
import { createFetchFragnoOutboxStreamingTransport } from "./streaming-transport";

const streamingSchema = schema("streaming_transport_e2e", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const TEST_BASE_URL = "http://tanstack-db-streaming.test";
const WAIT_TIMEOUT_MS = 2_000;

async function createStreamingHarness(options: { staticallyLoadBootstrap?: boolean } = {}) {
  const fragmentDefinition = defineFragment("tanstack-db-streaming-transport")
    .extend(withDatabase(streamingSchema))
    .build();
  const fragmentBuilder = instantiate(fragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions({
      mountRoute: "/streaming",
      outbox: { enabled: true },
    });
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment("server", fragmentBuilder)
    .build();
  const serverFragment = setup.fragments.server;
  const rawFetch = createFragmentTestFetcher(serverFragment.fragment, {
    baseUrl: TEST_BASE_URL,
  });
  const internalUrl = new URL(
    `${serverFragment.fragment.mountRoute}/_internal`,
    TEST_BASE_URL,
  ).toString();
  let bootstrap: FragnoOutboxBootstrap | undefined;

  if (options.staticallyLoadBootstrap) {
    const response = await rawFetch(internalUrl);
    const description = (await response.json()) as { adapterIdentity: string };
    bootstrap = { adapterIdentity: description.adapterIdentity };
  }

  const requests = {
    internal: 0,
    outbox: 0,
    stream: 0,
  };
  let disconnectCurrentStream: (() => Promise<void>) | undefined;
  const countingFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/_internal")) {
      requests.internal += 1;
    } else if (pathname.endsWith("/_internal/outbox")) {
      requests.outbox += 1;
    } else if (pathname.endsWith("/_internal/outbox/stream")) {
      requests.stream += 1;
      const response = await rawFetch(request);
      if (!response.body) {
        return response;
      }

      const upstream = response.body.getReader();
      let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          downstream = controller;
          void (async () => {
            try {
              while (!closed) {
                const next = await upstream.read();
                if (next.done) {
                  if (!closed) {
                    closed = true;
                    controller.close();
                  }
                  return;
                }
                controller.enqueue(next.value);
              }
            } catch (error) {
              if (!closed) {
                closed = true;
                controller.error(error);
              }
            }
          })();
        },
        async cancel(reason) {
          closed = true;
          await upstream.cancel(reason);
        },
      });

      disconnectCurrentStream = async () => {
        if (closed) {
          return;
        }
        closed = true;
        await upstream.cancel();
        downstream?.close();
      };

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return rawFetch(request);
  };
  const transport = createFetchFragnoOutboxStreamingTransport({
    internalUrl,
    fetch: countingFetch,
  });
  const coordinator = createFragnoOutboxCoordinator({
    internalUrl,
    bootstrap,
    transport,
    pageSize: 2,
    pollIntervalMs: 10,
  });
  const users = createCollection(
    fragnoCollectionOptions({
      id: `streaming-transport-users-${options.staticallyLoadBootstrap ? "static" : "dynamic"}`,
      coordinator,
      target: { schema: streamingSchema, table: "users" },
    }),
  );

  return {
    users,
    coordinator,
    requests,
    async disconnectStream() {
      const disconnect = disconnectCurrentStream;
      if (!disconnect) {
        throw new Error("Outbox stream is not connected.");
      }
      disconnectCurrentStream = undefined;
      await disconnect();
    },
    async createUser(id: string, name: string) {
      await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(streamingSchema).create("users", {
              id,
              name,
            }),
          )
          .execute();
      });
    },
    async updateUser(id: string, name: string) {
      await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) =>
            forSchema(streamingSchema).update("users", id, (update) => update.set({ name })),
          )
          .execute();
      });
    },
    async deleteUser(id: string) {
      await serverFragment.fragment.inContext(async function (this: DatabaseRequestContext) {
        await this.handlerTx()
          .mutate(({ forSchema }) => forSchema(streamingSchema).delete("users", id))
          .execute();
      });
    },
    async cleanup() {
      await users.cleanup();
      coordinator.dispose();
      await setup.test.cleanup();
    },
  };
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= WAIT_TIMEOUT_MS) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("Fragno streaming outbox transport end-to-end", () => {
  it("catches up and receives live insert, update, and delete entries", async () => {
    const harness = await createStreamingHarness();

    try {
      await harness.createUser("user-1", "Ada");
      await Promise.all([harness.users.preload(), harness.users.utils.initialSync()]);
      await waitFor(() => harness.requests.stream === 1, "Outbox stream did not connect.");

      expect(harness.users.get("user-1")).toMatchObject({ id: "user-1", name: "Ada" });

      await harness.createUser("user-2", "Lin");
      await waitFor(
        () => harness.users.get("user-2")?.name === "Lin",
        "Live insert did not reach the collection.",
      );

      await harness.updateUser("user-1", "Grace");
      await waitFor(
        () => harness.users.get("user-1")?.name === "Grace",
        "Live update did not reach the collection.",
      );

      await harness.deleteUser("user-2");
      await waitFor(
        () => !harness.users.has("user-2"),
        "Live delete did not reach the collection.",
      );

      await harness.users.utils.syncOnce();
      await waitFor(() => harness.requests.stream >= 2, "Outbox stream did not reconnect.");
      assert(harness.requests.internal === 1);
      assert(harness.requests.outbox >= 2);
    } finally {
      await harness.cleanup();
    }
  });

  it("catches up mutations committed while the stream reconnects", async () => {
    const harness = await createStreamingHarness();

    try {
      await harness.createUser("user-1", "Ada");
      await Promise.all([harness.users.preload(), harness.users.utils.initialSync()]);
      await waitFor(() => harness.requests.stream === 1, "Outbox stream did not connect.");
      const outboxRequestsBeforeDisconnect = harness.requests.outbox;

      await harness.disconnectStream();
      await harness.updateUser("user-1", "Grace");

      await waitFor(
        () => harness.users.get("user-1")?.name === "Grace",
        "Reconnect catch-up did not recover the committed update.",
      );
      assert(harness.requests.stream >= 2);
      assert(harness.requests.outbox === outboxRequestsBeforeDisconnect);
      assert(harness.requests.internal === 1);
    } finally {
      await harness.cleanup();
    }
  });

  it("uses server-loaded bootstrap data without requesting the internal describe route", async () => {
    const harness = await createStreamingHarness({ staticallyLoadBootstrap: true });

    try {
      await harness.createUser("user-1", "Ada");
      await Promise.all([harness.users.preload(), harness.users.utils.initialSync()]);
      await waitFor(() => harness.requests.stream === 1, "Outbox stream did not connect.");

      assert(harness.users.get("user-1")?.name === "Ada");
      assert(harness.requests.internal === 0);
    } finally {
      await harness.cleanup();
    }
  });
});
