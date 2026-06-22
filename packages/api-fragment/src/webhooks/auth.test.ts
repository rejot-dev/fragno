import { describe, expect, it } from "vitest";

import { bytesToBase64Url, bytesToHex, signHmacBytes, utf8Bytes } from "../crypto";
import {
  getSensitiveWebhookAuthValues,
  getWebhookAuthSecretRefs,
  timingSafeEqualBytes,
  timingSafeEqualText,
  verifyWebhookAuth,
  type WebhookAuthConfig,
  type WebhookSecretResolver,
} from "./auth";

const secrets = (values: Record<string, string>): WebhookSecretResolver => ({
  get: (ref) => values[ref],
});

const rawBodyHmacConfig = {
  type: "hmac",
  secretRef: "webhook-secret",
  algorithm: "sha256",
  signature: {
    location: "header",
    name: "x-signature",
    encoding: "hex",
    prefix: "sha256=",
  },
  signedPayload: { type: "rawBody" },
} satisfies WebhookAuthConfig;

describe("webhook auth", () => {
  it("accepts unauthenticated webhooks for auth type none", async () => {
    await expect(
      verifyWebhookAuth({
        config: { type: "none" },
        request: new Request("https://example.test/webhook"),
        secrets: secrets({}),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("verifies bearer authorization headers", async () => {
    const config = { type: "bearer", tokenRef: "token" } satisfies WebhookAuthConfig;

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook", {
          headers: { authorization: "Bearer expected-token" },
        }),
        secrets: secrets({ token: "expected-token" }),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook", {
          headers: { authorization: "Bearer wrong-token" },
        }),
        secrets: secrets({ token: "expected-token" }),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_credential" });
  });

  it("returns explicit failure reasons for missing bearer secrets and credentials", async () => {
    const config = { type: "bearer", tokenRef: "token" } satisfies WebhookAuthConfig;

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook"),
        secrets: secrets({}),
      }),
    ).resolves.toEqual({ ok: false, reason: "missing_secret" });

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook"),
        secrets: secrets({ token: "expected-token" }),
      }),
    ).resolves.toEqual({ ok: false, reason: "missing_credential" });
  });

  it("verifies API keys from headers and query parameters", async () => {
    await expect(
      verifyWebhookAuth({
        config: {
          type: "apiKey",
          location: "header",
          name: "x-api-key",
          secretRef: "key",
        },
        request: new Request("https://example.test/webhook", {
          headers: { "x-api-key": "header-secret" },
        }),
        secrets: secrets({ key: "header-secret" }),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyWebhookAuth({
        config: {
          type: "apiKey",
          location: "query",
          name: "token",
          secretRef: "key",
        },
        request: new Request("https://example.test/webhook?token=query-secret"),
        secrets: secrets({ key: "query-secret" }),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyWebhookAuth({
        config: {
          type: "apiKey",
          location: "query",
          name: "token",
          secretRef: "key",
        },
        request: new Request("https://example.test/webhook?token=wrong"),
        secrets: secrets({ key: "query-secret" }),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_credential" });
  });

  it("verifies basic auth without storing the encoded credential", async () => {
    const config = {
      type: "basic",
      usernameRef: "username",
      passwordRef: "password",
    } satisfies WebhookAuthConfig;

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook", {
          headers: { authorization: `Basic ${btoa("ada:lovelace")}` },
        }),
        secrets: secrets({ username: "ada", password: "lovelace" }),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook", {
          headers: { authorization: `Basic ${btoa("ada:wrong")}` },
        }),
        secrets: secrets({ username: "ada", password: "lovelace" }),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_credential" });
  });

  it("verifies HMAC signatures over the exact raw request body bytes", async () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = bytesToHex(
      await signHmacBytes({
        algorithm: "sha256",
        secret: "secret",
        payload: utf8Bytes(body),
      }),
    );
    const originalRequest = new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "x-signature": `sha256=${signature}` },
      body,
    });

    await expect(
      verifyWebhookAuth({
        config: rawBodyHmacConfig,
        request: originalRequest,
        secrets: secrets({ "webhook-secret": "secret" }),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(originalRequest.text()).resolves.toBe(body);
  });

  it("rejects invalid HMAC signatures", async () => {
    await expect(
      verifyWebhookAuth({
        config: rawBodyHmacConfig,
        request: new Request("https://example.test/webhook", {
          method: "POST",
          headers: { "x-signature": "sha256=deadbeef" },
          body: "body",
        }),
        secrets: secrets({ "webhook-secret": "secret" }),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_credential" });
  });

  it("supports base64url HMAC signatures in query parameters", async () => {
    const body = "payload";
    const signature = bytesToBase64Url(
      await signHmacBytes({
        algorithm: "sha512",
        secret: "secret",
        payload: utf8Bytes(body),
      }),
    );

    await expect(
      verifyWebhookAuth({
        config: {
          type: "hmac",
          secretRef: "secret",
          algorithm: "sha512",
          signature: {
            location: "query",
            name: "signature",
            encoding: "base64url",
          },
          signedPayload: { type: "rawBody" },
        },
        request: new Request(`https://example.test/webhook?signature=${signature}`, {
          method: "POST",
          body,
        }),
        secrets: secrets({ secret: "secret" }),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("verifies timestamped HMAC payloads and rejects replayed timestamps", async () => {
    const body = "body";
    const timestamp = "1700000000";
    const signedPayload = utf8Bytes(`${timestamp}.${body}`);
    const signature = bytesToHex(
      await signHmacBytes({ algorithm: "sha256", secret: "secret", payload: signedPayload }),
    );
    const config = {
      type: "hmac",
      secretRef: "secret",
      algorithm: "sha256",
      signature: {
        location: "header",
        name: "x-signature",
        encoding: "hex",
      },
      signedPayload: {
        type: "timestampBody",
        timestampHeader: "x-timestamp",
        delimiter: ".",
        toleranceSeconds: 300,
      },
    } satisfies WebhookAuthConfig;

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook", {
          method: "POST",
          headers: { "x-signature": signature, "x-timestamp": timestamp },
          body,
        }),
        secrets: secrets({ secret: "secret" }),
        now: new Date(1_700_000_000_000),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyWebhookAuth({
        config,
        request: new Request("https://example.test/webhook", {
          method: "POST",
          headers: { "x-signature": signature, "x-timestamp": timestamp },
          body,
        }),
        secrets: secrets({ secret: "secret" }),
        now: new Date(1_700_001_000_000),
      }),
    ).resolves.toEqual({ ok: false, reason: "timestamp_out_of_range" });
  });

  it("reports auth metadata for secret lookup and request redaction", () => {
    const configs = [
      { type: "none" },
      { type: "bearer", tokenRef: "token" },
      { type: "apiKey", location: "header", name: "x-api-key", secretRef: "key" },
      { type: "basic", usernameRef: "username", passwordRef: "password" },
      rawBodyHmacConfig,
    ] satisfies WebhookAuthConfig[];

    expect(configs.map(getWebhookAuthSecretRefs)).toEqual([
      [],
      ["token"],
      ["key"],
      ["username", "password"],
      ["webhook-secret"],
    ]);
    expect(configs.map(getSensitiveWebhookAuthValues)).toEqual([
      [],
      [{ location: "header", name: "authorization" }],
      [{ location: "header", name: "x-api-key" }],
      [{ location: "header", name: "authorization" }],
      [{ location: "header", name: "x-signature" }],
    ]);
  });

  it("compares text and byte credentials without accepting length mismatches", async () => {
    await expect(timingSafeEqualText("same", "same")).resolves.toBe(true);
    await expect(timingSafeEqualText("same", "same-plus")).resolves.toBe(false);
    await expect(
      timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2])),
    ).resolves.toBe(true);
    await expect(
      timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0])),
    ).resolves.toBe(false);
  });
});
