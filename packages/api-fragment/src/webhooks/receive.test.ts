import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";

import { instantiate } from "@fragno-dev/core";
import { internalSchema } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import type { WebhookDelivery, WebhookDeliveryIdentity } from "../api-types";
import { bytesToHex, signHmacBytes, utf8Bytes } from "../crypto";
import { apiFragmentDefinition } from "../definition";
import { apiRoutesFactory } from "../routes";

const onWebhookReceived = vi.fn();
const DELIVERY_RETENTION_MS = 60_000;

const buildApiTest = async () => {
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "api",
      instantiate(apiFragmentDefinition)
        .withConfig({
          webhookDeliveryRetentionMs: DELIVERY_RETENTION_MS,
          onWebhookReceived,
        })
        .withRoutes([apiRoutesFactory]),
    )
    .build();
  return setup;
};

type ApiTest = Awaited<ReturnType<typeof buildApiTest>>;

function webhookRequest(endpointId: string, init: RequestInit & { query?: string }) {
  return new Request(
    `https://app.test/api/api-fragment/webhooks/endpoints/${endpointId}/events${init.query ?? ""}`,
    init,
  );
}

async function createNoneWebhookEndpoint(
  test: ApiTest,
  endpointId: string,
  deliveryIdentity: WebhookDeliveryIdentity = { type: "header", name: "x-event-id" },
) {
  const response = await test.fragments.api.fragment.callRoute(
    "PUT",
    "/webhooks/endpoints/:endpointId",
    {
      pathParams: { endpointId },
      body: {
        name: endpointId,
        status: "active",
        verification: { type: "none" },
        deliveryIdentity,
        auth: { type: "none" },
      },
    },
  );
  assert(response.type === "json");
  return response;
}

describe("webhook receiving", () => {
  beforeEach(() => {
    onWebhookReceived.mockReset();
  });

  test("receives webhooks through a durable hook using a header delivery ID", async () => {
    const setup = await buildApiTest();
    await createNoneWebhookEndpoint(setup, "incoming");
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const response = await setup.fragments.api.fragment.handler(
      webhookRequest("incoming", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-event-id": "evt_1",
          traceparent,
        },
        body: JSON.stringify({ ok: true }),
      }),
    );
    assert(response.status === 202);
    expect(onWebhookReceived).not.toHaveBeenCalled();

    await drainDurableHooks(setup.fragments.api.fragment);

    expect(onWebhookReceived).toHaveBeenCalledOnce();
    expect(onWebhookReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "incoming",
        deliveryId: "evt_1",
        hookId: expect.stringMatching(/^webhook_/),
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-event-id": "evt_1",
        }),
        query: {},
        body: { ok: true },
        contentType: "application/json",
      }) satisfies Partial<WebhookDelivery>,
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        hookId: expect.any(Object),
        propagationContext: { traceparent },
      }),
    );

    await setup.test.cleanup();
  });

  test("receives webhooks using a query delivery ID", async () => {
    const setup = await buildApiTest();
    await createNoneWebhookEndpoint(setup, "query-identity", {
      type: "query",
      name: "event_id",
    });

    const response = await setup.fragments.api.fragment.handler(
      webhookRequest("query-identity", {
        method: "POST",
        query: "?event_id=evt_query",
        body: "{}",
      }),
    );
    assert(response.status === 202);

    await drainDurableHooks(setup.fragments.api.fragment);

    expect(onWebhookReceived).toHaveBeenCalledOnce();
    expect(onWebhookReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "query-identity",
        deliveryId: "evt_query",
        query: { event_id: "evt_query" },
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );

    await setup.test.cleanup();
  });

  test("authenticates and answers Slack-style URL verification before requiring a delivery ID", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    const signingSecret = "slack-signing-secret";

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "slack" },
      body: {
        name: "Slack",
        status: "active",
        verification: {
          type: "challenge",
          method: "POST",
          when: {
            type: "equals",
            source: { type: "jsonBodyPath", path: ["type"] },
            value: "url_verification",
          },
          response: {
            type: "echoText",
            source: { type: "jsonBodyPath", path: ["challenge"] },
          },
        },
        deliveryIdentity: { type: "jsonBodyPath", path: ["event_id"] },
        auth: {
          type: "hmac",
          secret: signingSecret,
          algorithm: "sha256",
          signature: {
            location: "header",
            name: "x-slack-signature",
            encoding: "hex",
            prefix: "v0=",
          },
          signedPayload: {
            type: "timestampedBody",
            prefix: "v0:",
            timestampHeader: "x-slack-request-timestamp",
            delimiter: ":",
            toleranceSeconds: 300,
          },
        },
      },
    });

    async function signedSlackRequest(body: string) {
      const timestamp = `${Math.floor(Date.now() / 1000)}`;
      const signature = bytesToHex(
        await signHmacBytes({
          algorithm: "sha256",
          secret: signingSecret,
          payload: utf8Bytes(`v0:${timestamp}:${body}`),
        }),
      );
      return webhookRequest("slack", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${signature}`,
        },
        body,
      });
    }

    const challenge = "slack-challenge";
    const challengeBody = JSON.stringify({ type: "url_verification", challenge });
    const rejectedVerification = await fragment.handler(
      webhookRequest("slack", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
          "x-slack-signature": "v0=deadbeef",
        },
        body: challengeBody,
      }),
    );
    assert(rejectedVerification.status === 401);

    const verificationResponse = await fragment.handler(await signedSlackRequest(challengeBody));
    assert(verificationResponse.status === 200);
    assert(verificationResponse.headers.get("content-type") === "text/plain; charset=utf-8");
    expect(verificationResponse.headers.get("content-length")).toBe(`${challenge.length}`);
    await expect(verificationResponse.text()).resolves.toBe(challenge);

    await drainDurableHooks(fragment);
    expect(onWebhookReceived).not.toHaveBeenCalled();

    const deliveryResponse = await fragment.handler(
      await signedSlackRequest(JSON.stringify({ type: "event_callback", event_id: "Ev123" })),
    );
    assert(deliveryResponse.status === 202);

    await drainDurableHooks(fragment);
    expect(onWebhookReceived).toHaveBeenCalledOnce();
    expect(onWebhookReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "slack",
        deliveryId: "Ev123",
        body: { type: "event_callback", event_id: "Ev123" },
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );

    await setup.test.cleanup();
  });

  test("answers GET query-string verification challenges without creating deliveries", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "query-challenge" },
      body: {
        name: "Query challenge",
        status: "active",
        verification: {
          type: "challenge",
          method: "GET",
          when: {
            type: "present",
            source: { type: "query", name: "validationToken" },
          },
          response: {
            type: "echoText",
            source: { type: "query", name: "validationToken" },
          },
        },
        deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
        auth: { type: "none" },
      },
    });

    const response = await fragment.handler(
      webhookRequest("query-challenge", {
        method: "GET",
        query: "?validationToken=opaque%20challenge",
      }),
    );
    assert(response.status === 200);
    await expect(response.text()).resolves.toBe("opaque challenge");

    await drainDurableHooks(fragment);
    expect(onWebhookReceived).not.toHaveBeenCalled();

    await setup.test.cleanup();
  });

  test("receives HMAC authenticated webhooks using a JSON body path delivery ID", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    const body = JSON.stringify({ event: { id: "evt_json" }, type: "signed" });
    const signature = bytesToHex(
      await signHmacBytes({ algorithm: "sha256", secret: "hmac-secret", payload: utf8Bytes(body) }),
    );

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "signed" },
      body: {
        name: "Signed",
        status: "active",
        verification: { type: "none" },
        deliveryIdentity: { type: "jsonBodyPath", path: ["event", "id"] },
        auth: {
          type: "hmac",
          secret: "hmac-secret",
          algorithm: "sha256",
          signature: {
            location: "header",
            name: "x-signature",
            encoding: "hex",
            prefix: "sha256=",
          },
          signedPayload: { type: "rawBody" },
        },
      },
    });

    const response = await fragment.handler(
      webhookRequest("signed", {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": `sha256=${signature}` },
        body,
      }),
    );
    assert(response.status === 202);

    await drainDurableHooks(fragment);

    expect(onWebhookReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "signed",
        deliveryId: "evt_json",
        headers: expect.objectContaining({ "x-signature": "[redacted]" }),
        body: { event: { id: "evt_json" }, type: "signed" },
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );

    await setup.test.cleanup();
  });

  test("rejects webhook deliveries before durable hook processing when endpoint auth fails", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "bearer" },
      body: {
        name: "Bearer",
        status: "active",
        verification: { type: "none" },
        deliveryIdentity: { type: "header", name: "x-event-id" },
        auth: { type: "bearer", token: "expected-token" },
      },
    });

    const response = await fragment.handler(
      webhookRequest("bearer", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "x-event-id": "evt_auth" },
        body: "{}",
      }),
    );
    assert(response.status === 401);
    await expect(response.json()).resolves.toMatchObject({ code: "WEBHOOK_AUTH_FAILED" });

    await drainDurableHooks(fragment);
    expect(onWebhookReceived).not.toHaveBeenCalled();

    await setup.test.cleanup();
  });

  test("keeps the latest accepted and rejected request until the configuration changes", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    async function readDeliveries() {
      const endpoint = await fragment.callRoute("GET", "/webhooks/endpoints/:endpointId", {
        pathParams: { endpointId: "bearer" },
      });
      assert(endpoint.type === "json");
      return endpoint.data.deliveries;
    }
    function deliver(token: string, eventId: string) {
      return fragment.handler(
        webhookRequest("bearer", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-event-id": eventId },
          body: "{}",
        }),
      );
    }

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "bearer" },
      body: {
        name: "Bearer",
        status: "active",
        verification: { type: "none" },
        deliveryIdentity: { type: "header", name: "x-event-id" },
        auth: { type: "bearer", token: "expected-token" },
      },
    });
    expect(await readDeliveries()).toEqual({ lastAcceptedAt: null, lastRejection: null });

    assert((await deliver("wrong-token", "evt_1")).status === 401);
    expect(await readDeliveries()).toEqual({
      lastAcceptedAt: null,
      lastRejection: { receivedAt: expect.any(String), code: "WEBHOOK_AUTH_FAILED" },
    });

    assert((await deliver("expected-token", "evt_2")).status === 202);
    const afterAccepted = await readDeliveries();
    expect(afterAccepted).toEqual({
      lastAcceptedAt: expect.any(String),
      lastRejection: { receivedAt: expect.any(String), code: "WEBHOOK_AUTH_FAILED" },
    });
    assert(afterAccepted.lastAcceptedAt !== null && afterAccepted.lastRejection !== null);
    expect(Date.parse(afterAccepted.lastAcceptedAt)).toBeGreaterThanOrEqual(
      Date.parse(afterAccepted.lastRejection.receivedAt),
    );

    // Evidence describes the configuration it was collected under.
    await fragment.callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "bearer" },
      body: { name: "Renamed" },
    });
    expect(await readDeliveries()).toEqual({ lastAcceptedAt: null, lastRejection: null });

    await setup.test.cleanup();
  });

  test("rejects disabled and missing webhook endpoints without durable hook processing", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "disabled" },
      body: {
        name: "Disabled",
        status: "disabled",
        verification: { type: "none" },
        deliveryIdentity: { type: "header", name: "x-event-id" },
        auth: { type: "none" },
      },
    });

    const disabled = await fragment.handler(
      webhookRequest("disabled", {
        method: "POST",
        headers: { "x-event-id": "evt_disabled" },
        body: "{}",
      }),
    );
    assert(disabled.status === 409);
    await expect(disabled.json()).resolves.toMatchObject({ code: "WEBHOOK_ENDPOINT_DISABLED" });

    const missing = await fragment.handler(
      webhookRequest("missing", {
        method: "POST",
        headers: { "x-event-id": "evt_missing" },
        body: "{}",
      }),
    );
    assert(missing.status === 404);
    await expect(missing.json()).resolves.toMatchObject({ code: "WEBHOOK_ENDPOINT_NOT_FOUND" });

    await drainDurableHooks(fragment);
    expect(onWebhookReceived).not.toHaveBeenCalled();

    await setup.test.cleanup();
  });

  test("rejects deliveries when the configured delivery ID is missing or invalid", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    await createNoneWebhookEndpoint(setup, "json-identity", {
      type: "jsonBodyPath",
      path: ["event", "id"],
    });

    const missing = await fragment.handler(
      webhookRequest("json-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: {} }),
      }),
    );
    assert(missing.status === 400);
    await expect(missing.json()).resolves.toMatchObject({ code: "WEBHOOK_DELIVERY_ID_MISSING" });

    const invalid = await fragment.handler(
      webhookRequest("json-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: { id: { nested: true } } }),
      }),
    );
    assert(invalid.status === 400);
    await expect(invalid.json()).resolves.toMatchObject({ code: "WEBHOOK_DELIVERY_ID_INVALID" });

    const invalidJson = await fragment.handler(
      webhookRequest("json-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
    );
    assert(invalidJson.status === 400);
    await expect(invalidJson.json()).resolves.toMatchObject({
      code: "WEBHOOK_BODY_INVALID",
    });

    await drainDurableHooks(fragment);
    expect(onWebhookReceived).not.toHaveBeenCalled();

    await setup.test.cleanup();
  });

  test("dedupes repeated webhook deliveries by derived durable hook ID", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    const body = JSON.stringify({ eventId: "evt_same" });
    await createNoneWebhookEndpoint(setup, "dedupe");

    const first = await fragment.handler(
      webhookRequest("dedupe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-event-id": "evt_same" },
        body,
      }),
    );
    const second = await fragment.handler(
      webhookRequest("dedupe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-event-id": "evt_same" },
        body,
      }),
    );
    assert(first.status === 202);
    assert(second.status === 202);

    await drainDurableHooks(fragment);

    expect(onWebhookReceived).toHaveBeenCalledTimes(1);
    expect(onWebhookReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId: "dedupe",
        deliveryId: "evt_same",
        body: { eventId: "evt_same" },
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(Object) }),
    );

    await setup.test.cleanup();
  });

  test("keeps deliveries until their retention after processing passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    try {
      const setup = await buildApiTest();
      const fragment = setup.fragments.api.fragment;
      await createNoneWebhookEndpoint(setup, "retained");
      const deliver = async (eventId: string) => {
        const response = await fragment.handler(
          webhookRequest("retained", {
            method: "POST",
            headers: { "content-type": "application/json", "x-event-id": eventId },
            body: JSON.stringify({ eventId }),
          }),
        );
        assert(response.status === 202);
      };
      const readDelivery = (deliveryId: string) =>
        fragment.callRoute("GET", "/webhooks/endpoints/:endpointId/deliveries/:deliveryId", {
          pathParams: { endpointId: "retained", deliveryId },
        });

      await deliver("evt_old");
      // A delivery whose hook has not run is kept however long ago it arrived.
      vi.setSystemTime(start + 2 * DELIVERY_RETENTION_MS);
      await deliver("evt_new");
      const pending = await readDelivery("evt_old");
      assert(pending.type === "json");
      expect(pending.data).toMatchObject({
        deliveryId: "evt_old",
        receivedAt: "2026-01-01T00:00:00.000Z",
        body: { eventId: "evt_old" },
        contentType: "application/json",
      });

      await drainDurableHooks(fragment);
      expect(onWebhookReceived.mock.calls.map(([delivery]) => delivery.deliveryId)).toEqual([
        "evt_old",
        "evt_new",
      ]);

      vi.setSystemTime(start + 3 * DELIVERY_RETENTION_MS + 1);
      await deliver("evt_latest");
      for (const deliveryId of ["evt_old", "evt_new"]) {
        const expired = await readDelivery(deliveryId);
        assert(expired.type === "error");
        assert(expired.error.code === "WEBHOOK_DELIVERY_NOT_FOUND");
      }
      assert((await readDelivery("evt_latest")).type === "json");

      await setup.test.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a replayed hook whose completion was lost neither reruns nor fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    try {
      const setup = await buildApiTest();
      const { fragment, db } = setup.fragments.api;
      await createNoneWebhookEndpoint(setup, "replayed");
      const deliver = async (eventId: string) => {
        const response = await fragment.handler(
          webhookRequest("replayed", {
            method: "POST",
            headers: { "x-event-id": eventId },
            body: "{}",
          }),
        );
        assert(response.status === 202);
      };
      const readHooks = async () => {
        const [hooks] = await db
          .createUnitOfWork("read-hooks")
          .forSchema(internalSchema)
          .find("fragno_hooks", (b) => b.whereIndex("primary"))
          .executeRetrieve();
        return hooks.filter((hook) => hook.hookName === "onWebhookReceived");
      };
      // The callback committed, but the processor stopped before settling the hook, which stale
      // recovery later replays.
      const loseCompletion = async () => {
        const [hook] = await readHooks();
        assert(hook);
        const uow = db.createUnitOfWork("lose-completion").forSchema(internalSchema);
        uow.update("fragno_hooks", hook.id, (b) =>
          b.set({ status: "processing", lastAttemptAt: new Date(start) }),
        );
        assert((await uow.executeMutations()).success);
      };

      await deliver("evt_replayed");
      await drainDurableHooks(fragment);
      await loseCompletion();
      vi.setSystemTime(start + 11 * 60_000);
      await drainDurableHooks(fragment);
      expect(onWebhookReceived).toHaveBeenCalledOnce();

      // A later delivery deletes the processed one before the replay finds it.
      await loseCompletion();
      await deliver("evt_later");
      const expired = await fragment.callRoute(
        "GET",
        "/webhooks/endpoints/:endpointId/deliveries/:deliveryId",
        { pathParams: { endpointId: "replayed", deliveryId: "evt_replayed" } },
      );
      assert(expired.type === "error");
      assert(expired.error.code === "WEBHOOK_DELIVERY_NOT_FOUND");
      await drainDurableHooks(fragment);

      expect(onWebhookReceived.mock.calls.map(([delivery]) => delivery.deliveryId)).toEqual([
        "evt_replayed",
        "evt_later",
      ]);
      expect(await readHooks()).toMatchObject([
        { status: "completed", attempts: 0 },
        { status: "completed", attempts: 0 },
      ]);

      await setup.test.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a retention that is not a positive whole number of milliseconds", () => {
    for (const webhookDeliveryRetentionMs of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        instantiate(apiFragmentDefinition)
          .withConfig({ webhookDeliveryRetentionMs })
          .withRoutes([apiRoutesFactory])
          .withOptions({ databaseAdapter: undefined })
          .build(),
      ).toThrow("webhookDeliveryRetentionMs must be a positive whole number");
    }
  });

  test("does not dedupe different delivery IDs with the same body", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    const body = JSON.stringify({ ok: true });
    await createNoneWebhookEndpoint(setup, "different-deliveries");

    const first = await fragment.handler(
      webhookRequest("different-deliveries", {
        method: "POST",
        headers: { "content-type": "application/json", "x-event-id": "evt_1" },
        body,
      }),
    );
    const second = await fragment.handler(
      webhookRequest("different-deliveries", {
        method: "POST",
        headers: { "content-type": "application/json", "x-event-id": "evt_2" },
        body,
      }),
    );
    assert(first.status === 202);
    assert(second.status === 202);

    await drainDurableHooks(fragment);

    expect(onWebhookReceived).toHaveBeenCalledTimes(2);
    expect(
      onWebhookReceived.mock.calls
        .map(([payload]) => payload.deliveryId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["evt_1", "evt_2"]);

    await setup.test.cleanup();
  });

  test("allows a later webhook callback to finish while an earlier callback is active", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;
    const dispatcher = createDurableHooksProcessor([fragment]);
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondFinished = Promise.withResolvers<void>();
    const completionOrder: string[] = [];

    onWebhookReceived.mockImplementation(async (payload: WebhookDelivery) => {
      if (payload.deliveryId === "evt_1") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      completionOrder.push(payload.deliveryId);
      if (payload.deliveryId === "evt_2") {
        secondFinished.resolve();
      }
    });

    await createNoneWebhookEndpoint(setup, "overlapping-deliveries");
    const firstResponse = await fragment.handler(
      webhookRequest("overlapping-deliveries", {
        method: "POST",
        headers: { "x-event-id": "evt_1" },
        body: "{}",
      }),
    );
    assert(firstResponse.status === 202);

    const firstRun = dispatcher.wake();
    let secondRun: Promise<void> | undefined;
    try {
      await firstStarted.promise;

      const secondResponse = await fragment.handler(
        webhookRequest("overlapping-deliveries", {
          method: "POST",
          headers: { "x-event-id": "evt_2" },
          body: "{}",
        }),
      );
      assert(secondResponse.status === 202);

      secondRun = dispatcher.wake();
      await secondFinished.promise;
      expect(completionOrder).toEqual(["evt_2"]);
    } finally {
      releaseFirst.resolve();
      await Promise.all([firstRun, secondRun]);
      await dispatcher.drain();
      await setup.test.cleanup();
    }

    expect(completionOrder).toEqual(["evt_2", "evt_1"]);
  });
});
