import { describe, expect, it } from "vitest";

import {
  createWebhookRequestValues,
  evaluateWebhookVerification,
  type WebhookVerificationConfig,
} from "./verification";

function requestValues(url: string, body?: string, headers: HeadersInit = {}) {
  const requestUrl = new URL(url);
  return createWebhookRequestValues({
    headers: new Headers(headers),
    query: requestUrl.searchParams,
    rawBody: body,
  });
}

describe("webhook endpoint verification", () => {
  it("echoes a JSON challenge when the request discriminator matches", () => {
    const config = {
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
    } satisfies WebhookVerificationConfig;

    expect(
      evaluateWebhookVerification({
        config,
        method: "POST",
        requestValues: requestValues(
          "https://example.test/webhook",
          JSON.stringify({ type: "url_verification", challenge: "challenge-value" }),
        ),
      }),
    ).toEqual({ type: "response", body: "challenge-value" });
  });

  it("echoes an opaque query challenge without trimming or re-encoding it", () => {
    const config = {
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
    } satisfies WebhookVerificationConfig;

    expect(
      evaluateWebhookVerification({
        config,
        method: "GET",
        requestValues: requestValues(
          "https://example.test/webhook?validationToken=opaque%20challenge",
        ),
      }),
    ).toEqual({ type: "response", body: "opaque challenge" });
  });

  it("does not treat another method or discriminator as verification", () => {
    const config = {
      type: "challenge",
      method: "POST",
      when: {
        type: "equals",
        source: { type: "header", name: "x-message-type" },
        value: "verification",
      },
      response: {
        type: "echoText",
        source: { type: "jsonBodyPath", path: ["challenge"] },
      },
    } satisfies WebhookVerificationConfig;
    const values = requestValues("https://example.test/webhook", "{}", {
      "x-message-type": "notification",
    });

    expect(evaluateWebhookVerification({ config, method: "GET", requestValues: values })).toEqual({
      type: "not_verification",
    });
    expect(evaluateWebhookVerification({ config, method: "POST", requestValues: values })).toEqual({
      type: "not_verification",
    });
  });

  it("reports a matched verification request with a missing challenge", () => {
    const config = {
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
    } satisfies WebhookVerificationConfig;

    expect(
      evaluateWebhookVerification({
        config,
        method: "POST",
        requestValues: requestValues(
          "https://example.test/webhook",
          JSON.stringify({ type: "url_verification" }),
        ),
      }),
    ).toEqual({ type: "invalid_response", reason: "missing" });
  });
});
