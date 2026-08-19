import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import type { WebhookDeliveryIdentity } from "../api-types";
import { bytesToHex, signHmacBytes, utf8Bytes } from "../crypto";
import { apiFragmentDefinition, type WebhookReceivedPayload } from "../definition";
import { apiRoutesFactory } from "../routes";

const onWebhookReceived = vi.fn();

const buildApiTest = async () => {
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "api",
      instantiate(apiFragmentDefinition)
        .withConfig({
          publicBaseUrl: "https://app.test",
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
      }) satisfies Partial<WebhookReceivedPayload>,
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

    onWebhookReceived.mockImplementation(async (payload: WebhookReceivedPayload) => {
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
