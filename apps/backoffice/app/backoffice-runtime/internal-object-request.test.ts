import { assert, describe, expect, test } from "vitest";

import { createBackofficeUserExecution } from "./context";
import {
  BACKOFFICE_INTERNAL_CONTEXT_HEADER,
  BackofficeInternalRequestError,
  createAuthorizedBackofficeObjectRequest,
  verifyAuthorizedBackofficeObjectRequest,
} from "./internal-object-request";
import type { BackofficeObjectAddress } from "./object-registry";

const env = {
  BACKOFFICE_INTERNAL_REQUEST_SECRET: "backoffice-internal-request-test-secret-1234567890",
} satisfies Pick<CloudflareEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;

const address = {
  binding: "AUTOMATIONS",
  scope: { kind: "org", orgId: "org-1" },
} as const satisfies BackofficeObjectAddress;

const execution = createBackofficeUserExecution({
  scope: { kind: "org", orgId: "org-1" },
  userId: "user-1",
});

const issuedAtEpochMs = Date.parse("2026-08-27T12:00:00.000Z");

async function authorizedRequest(
  request = new Request("https://automations.test/api/pi/sessions?limit=10", {
    headers: { [BACKOFFICE_INTERNAL_CONTEXT_HEADER]: "caller-controlled" },
  }),
) {
  return await createAuthorizedBackofficeObjectRequest({
    request,
    address,
    context: {
      execution,
      propagationContext: { traceparent: "00-test-trace-test-span-01" },
    },
    env,
    nowEpochMs: issuedAtEpochMs,
    requestId: "17079b77-c6f0-4e4e-ae42-dbab28bf62d4",
  });
}

describe("Backoffice internal object requests", () => {
  test("round-trips trusted execution context and removes the internal header", async () => {
    const verified = await verifyAuthorizedBackofficeObjectRequest({
      request: await authorizedRequest(),
      address,
      env,
      nowEpochMs: issuedAtEpochMs + 1_000,
    });

    expect(verified.context).toEqual({
      execution,
      propagationContext: { traceparent: "00-test-trace-test-span-01" },
    });
    assert(verified.requestId === "17079b77-c6f0-4e4e-ae42-dbab28bf62d4");
    assert(!verified.request.headers.has(BACKOFFICE_INTERNAL_CONTEXT_HEADER));
  });

  test("rejects an envelope whose signature was modified", async () => {
    const request = await authorizedRequest();
    const envelope = request.headers.get(BACKOFFICE_INTERNAL_CONTEXT_HEADER)!;
    const headers = new Headers(request.headers);
    headers.set(
      BACKOFFICE_INTERNAL_CONTEXT_HEADER,
      `${envelope.slice(0, -1)}${envelope.endsWith("a") ? "b" : "a"}`,
    );

    await expect(
      verifyAuthorizedBackofficeObjectRequest({
        request: new Request(request, { headers }),
        address,
        env,
        nowEpochMs: issuedAtEpochMs + 1_000,
      }),
    ).rejects.toBeInstanceOf(BackofficeInternalRequestError);
  });

  test("binds the envelope to the HTTP target", async () => {
    const request = await authorizedRequest();

    await expect(
      verifyAuthorizedBackofficeObjectRequest({
        request: new Request("https://automations.test/api/pi/other?limit=10", request),
        address,
        env,
        nowEpochMs: issuedAtEpochMs + 1_000,
      }),
    ).rejects.toThrow("does not match its request target");
  });

  test("rejects expired envelopes", async () => {
    await expect(
      verifyAuthorizedBackofficeObjectRequest({
        request: await authorizedRequest(),
        address,
        env,
        nowEpochMs: issuedAtEpochMs + 30_000,
      }),
    ).rejects.toThrow("has expired");
  });

  test("rejects execution scope that differs from the object identity", async () => {
    const request = await createAuthorizedBackofficeObjectRequest({
      request: new Request("https://automations.test/api/pi/sessions"),
      address,
      context: {
        execution: createBackofficeUserExecution({
          scope: { kind: "org", orgId: "org-2" },
          userId: "user-1",
        }),
        propagationContext: null,
      },
      env,
      nowEpochMs: issuedAtEpochMs,
    });

    await expect(
      verifyAuthorizedBackofficeObjectRequest({
        request,
        address,
        env,
        nowEpochMs: issuedAtEpochMs + 1_000,
      }),
    ).rejects.toThrow("execution scope does not match the object address");
  });
});
