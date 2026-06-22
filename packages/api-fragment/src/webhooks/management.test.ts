import { assert, describe, expect, test } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { apiFragmentDefinition } from "../definition";
import { createApiFragmentClients } from "../index";
import { apiRoutesFactory } from "../routes";
import { apiSchema } from "../schema";

const buildApiTest = async () => {
  const setup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 1 })
    .withFragment(
      "api",
      instantiate(apiFragmentDefinition)
        .withConfig({
          publicBaseUrl: "https://app.test",
        })
        .withRoutes([apiRoutesFactory]),
    )
    .build();
  return setup;
};

type ApiTest = Awaited<ReturnType<typeof buildApiTest>>;

async function readWebhookSecrets(test: ApiTest, endpointId: string) {
  const [secrets] = await test.fragments.api.db
    .createUnitOfWork("read-webhook-secrets")
    .forSchema(apiSchema)
    .find("webhookSecret", (b) =>
      b.whereIndex("idx_webhook_secret_endpoint_ref", (eb) => eb("endpointId", "=", endpointId)),
    )
    .executeRetrieve();
  return secrets;
}

describe("webhook endpoint management", () => {
  test("exports webhook endpoint client builders", () => {
    const clients = createApiFragmentClients();

    expect(clients.useWebhookEndpoints).toBeDefined();
    expect(clients.useWebhookEndpoint).toBeDefined();
    expect(clients.createWebhookEndpoint).toBeDefined();
    expect(clients.updateWebhookEndpoint).toBeDefined();
    expect(clients.deleteWebhookEndpoint).toBeDefined();
  });

  test("creates, lists, updates, and deletes webhook endpoints without leaking secrets", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const created = await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "stripe" },
      body: {
        name: "Stripe",
        status: "active",
        deliveryIdentity: { type: "header", name: "stripe-event-id" },
        auth: {
          type: "hmac",
          secret: "whsec_secret",
          algorithm: "sha256",
          signature: {
            location: "header",
            name: "stripe-signature",
            encoding: "hex",
            prefix: "v1=",
          },
          signedPayload: {
            type: "timestampBody",
            timestampHeader: "stripe-timestamp",
            delimiter: ".",
            toleranceSeconds: 300,
          },
        },
      },
    });
    assert(created.type === "json");
    assert(created.status === 201);
    expect(created.data).toMatchObject({
      id: "stripe",
      name: "Stripe",
      status: "active",
      secretRefs: ["secret"],
      authConfig: expect.objectContaining({ type: "hmac", secretRef: "secret" }),
      deliveryIdentity: { type: "header", name: "stripe-event-id" },
    });
    expect(JSON.stringify(created.data)).not.toContain("whsec_secret");

    const secrets = await readWebhookSecrets(setup, "stripe");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({ ref: "secret", payload: "whsec_secret" });

    const list = await fragment.callRoute("GET", "/webhooks/endpoints");
    assert(list.type === "json");
    expect(list.data.endpoints).toEqual([expect.objectContaining({ id: "stripe" })]);

    const read = await fragment.callRoute("GET", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "stripe" },
    });
    assert(read.type === "json");
    expect(read.data).toMatchObject({ id: "stripe", name: "Stripe" });
    expect(JSON.stringify(read.data)).not.toContain("whsec_secret");

    const updated = await fragment.callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "stripe" },
      body: {
        status: "disabled",
        auth: { type: "bearer", token: "new-token" },
      },
    });
    assert(updated.type === "json");
    expect(updated.data).toMatchObject({
      id: "stripe",
      status: "disabled",
      secretRefs: ["token"],
      authConfig: { type: "bearer", tokenRef: "token" },
    });
    expect(JSON.stringify(updated.data)).not.toContain("new-token");

    const updatedSecrets = await readWebhookSecrets(setup, "stripe");
    expect(updatedSecrets).toHaveLength(1);
    expect(updatedSecrets[0]).toMatchObject({ ref: "token", payload: "new-token" });

    const deleted = await fragment.callRoute("DELETE", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "stripe" },
    });
    assert(deleted.type === "empty");
    assert(deleted.status === 204);

    const repeatedDelete = await fragment.callRoute("DELETE", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "stripe" },
    });
    assert(repeatedDelete.type === "empty");
    assert(repeatedDelete.status === 204);

    expect(await readWebhookSecrets(setup, "stripe")).toHaveLength(0);

    const missing = await fragment.callRoute("GET", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "stripe" },
    });
    assert(missing.type === "error");
    assert(missing.error.code === "WEBHOOK_ENDPOINT_NOT_FOUND");

    await setup.test.cleanup();
  });

  test("PATCH is idempotent and replaces webhook endpoint secrets when auth is provided", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "patched-webhook" },
      body: {
        name: "Before Patch",
        status: "active",
        deliveryIdentity: { type: "header", name: "x-event-id" },
        auth: { type: "bearer", token: "before-token" },
      },
    });

    const patchBody = {
      name: "After Patch",
      status: "disabled",
      deliveryIdentity: { type: "query", name: "event_id" },
      auth: { type: "basic", username: "ada", password: "lovelace" },
    } as const;

    const patched = await fragment.callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "patched-webhook" },
      body: patchBody,
    });
    assert(patched.type === "json");
    assert(patched.status === 200);
    expect(patched.data).toMatchObject({
      id: "patched-webhook",
      name: "After Patch",
      status: "disabled",
      authConfig: { type: "basic", usernameRef: "username", passwordRef: "password" },
      deliveryIdentity: { type: "query", name: "event_id" },
      secretRefs: ["username", "password"],
    });

    const repeatedPatch = await fragment.callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "patched-webhook" },
      body: patchBody,
    });
    assert(repeatedPatch.type === "json");
    assert(repeatedPatch.status === 200);
    expect(repeatedPatch.data).toMatchObject(patched.data);

    const secrets = await readWebhookSecrets(setup, "patched-webhook");
    expect(
      secrets
        .map((secret) => ({ ref: secret.ref, payload: secret.payload }))
        .toSorted((left, right) => left.ref.localeCompare(right.ref)),
    ).toEqual([
      { ref: "password", payload: "lovelace" },
      { ref: "username", payload: "ada" },
    ]);

    await setup.test.cleanup();
  });

  test("PATCH keeps existing webhook endpoint auth when auth is omitted", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "metadata-only" },
      body: {
        name: "Before",
        status: "active",
        deliveryIdentity: { type: "jsonBodyPath", path: ["event", "id"] },
        auth: { type: "bearer", token: "kept-token" },
      },
    });

    const patched = await fragment.callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "metadata-only" },
      body: { name: "After" },
    });
    assert(patched.type === "json");
    expect(patched.data).toMatchObject({
      id: "metadata-only",
      name: "After",
      status: "active",
      authConfig: { type: "bearer", tokenRef: "token" },
      deliveryIdentity: { type: "jsonBodyPath", path: ["event", "id"] },
      secretRefs: ["token"],
    });

    const secrets = await readWebhookSecrets(setup, "metadata-only");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({ ref: "token", payload: "kept-token" });

    await setup.test.cleanup();
  });

  test("PATCH returns a stable not-found response for missing webhook endpoints", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const first = await fragment.callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "missing-webhook" },
      body: { name: "Missing" },
    });
    assert(first.type === "error");
    assert(first.error.code === "WEBHOOK_ENDPOINT_NOT_FOUND");

    const second = await fragment.callRoute("PATCH", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "missing-webhook" },
      body: { name: "Missing" },
    });
    assert(second.type === "error");
    expect(second.error).toMatchObject(first.error);

    await setup.test.cleanup();
  });

  test("DELETE is idempotent for missing webhook endpoints", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const first = await fragment.callRoute("DELETE", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "missing-webhook" },
    });
    assert(first.type === "empty");
    assert(first.status === 204);

    const second = await fragment.callRoute("DELETE", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "missing-webhook" },
    });
    assert(second.type === "empty");
    assert(second.status === 204);

    await setup.test.cleanup();
  });

  test("PUT is idempotent and replaces webhook endpoint secrets", async () => {
    const setup = await buildApiTest();
    const fragment = setup.fragments.api.fragment;

    const body = {
      name: "Idempotent",
      status: "active",
      deliveryIdentity: { type: "header", name: "x-event-id" },
      auth: { type: "bearer", token: "first-token" },
    } as const;

    const created = await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "idempotent-webhook" },
      body,
    });
    assert(created.type === "json");
    assert(created.status === 201);

    const repeated = await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "idempotent-webhook" },
      body,
    });
    assert(repeated.type === "json");
    assert(repeated.status === 200);
    expect(repeated.data).toMatchObject(created.data);

    const replaced = await fragment.callRoute("PUT", "/webhooks/endpoints/:endpointId", {
      pathParams: { endpointId: "idempotent-webhook" },
      body: {
        name: "Replaced",
        status: "disabled",
        deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
        auth: { type: "basic", username: "ada", password: "lovelace" },
      },
    });
    assert(replaced.type === "json");
    assert(replaced.status === 200);
    expect(replaced.data).toMatchObject({
      id: "idempotent-webhook",
      name: "Replaced",
      status: "disabled",
      authConfig: { type: "basic", usernameRef: "username", passwordRef: "password" },
      deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
      secretRefs: ["username", "password"],
    });

    const secrets = await readWebhookSecrets(setup, "idempotent-webhook");
    expect(secrets).toHaveLength(2);
    expect(
      secrets
        .map((secret) => ({ ref: secret.ref, payload: secret.payload }))
        .toSorted((left, right) => left.ref.localeCompare(right.ref)),
    ).toEqual([
      { ref: "password", payload: "lovelace" },
      { ref: "username", payload: "ada" },
    ]);

    await setup.test.cleanup();
  });
});
