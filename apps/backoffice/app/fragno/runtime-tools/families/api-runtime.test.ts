import { describe, expect, test } from "vitest";

import { createRouteBackedApiRuntime } from "./api-runtime";

const publicAddress = {
  baseUrl: "https://backoffice.example/api/http/org%3Aacme",
  oauthRedirectUri: "https://backoffice.example/api/http/org%3Aacme/oauth/callback",
};

describe("route-backed API runtime public addresses", () => {
  test("adds the public URL to webhook endpoint results outside the API object", async () => {
    const runtime = createRouteBackedApiRuntime({
      baseUrl: "https://api.do",
      resolvePublicAddress: async () => publicAddress,
      fetch: async () =>
        Response.json({
          endpoints: [
            {
              id: "stripe/events",
              name: "Stripe",
              status: "active",
              authConfig: { type: "none" },
              verification: { type: "none" },
              deliveryIdentity: { type: "header", name: "x-delivery-id" },
              secretRefs: [],
            },
          ],
        }),
    });

    await expect(runtime.listWebhookEndpoints()).resolves.toMatchObject({
      endpoints: [
        {
          id: "stripe/events",
          publicUrl:
            "https://backoffice.example/api/http/org%3Aacme/webhooks/endpoints/stripe%2Fevents/events",
        },
      ],
    });
  });
});
