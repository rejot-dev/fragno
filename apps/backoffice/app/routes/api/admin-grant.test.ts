import { afterEach, assert, describe, expect, it, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { RouterContextProvider } from "react-router";

import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { AuthObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { action } from "./admin-grant";

const runtimes: Array<Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

function createRequest(token = "grant-secret", body: unknown = { email: "Admin@Rejot.dev" }) {
  return new Request("https://backoffice.example.com/api/admin/grant", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function createRouteContext(
  configuredToken: string | undefined,
  auth: Pick<AuthObject, "grantBackofficeAdminByEmail">,
) {
  const context = new RouterContextProvider();
  const runtime = {
    objects: {
      auth: {
        singleton: () => auth,
      },
    },
  } as unknown as BackofficeRuntimeServices;
  context.set(BackofficeWorkerContext, {
    runtime,
    kernel: {} as BackofficeKernel,
    env: { AUTH_ADMIN_GRANT_TOKEN: configuredToken } as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

function callAction(
  request: Request,
  configuredToken: string | undefined,
  auth: Pick<AuthObject, "grantBackofficeAdminByEmail">,
) {
  return action({
    request,
    url: new URL(request.url),
    context: createRouteContext(configuredToken, auth),
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

describe("Backoffice administrator grant route", () => {
  it("is unavailable when the grant token is not configured", async () => {
    const grantBackofficeAdminByEmail = vi.fn<AuthObject["grantBackofficeAdminByEmail"]>();

    const response = await callAction(createRequest(), undefined, {
      grantBackofficeAdminByEmail,
    });

    assert(response.status === 404);
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid grant token", async () => {
    const grantBackofficeAdminByEmail = vi.fn<AuthObject["grantBackofficeAdminByEmail"]>();

    const response = await callAction(createRequest("wrong-secret"), "grant-secret", {
      grantBackofficeAdminByEmail,
    });

    assert(response.status === 401);
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });

  it("rejects administrator access outside rejot.dev", async () => {
    const grantBackofficeAdminByEmail = vi.fn<AuthObject["grantBackofficeAdminByEmail"]>();

    const response = await callAction(
      createRequest("grant-secret", { email: "admin@example.com" }),
      "grant-secret",
      { grantBackofficeAdminByEmail },
    );

    assert(response.status === 400);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access requires a @rejot.dev email address.",
    });
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });

  it("grants administrator access to the normalized email", async () => {
    const runtime = await createInMemoryBackofficeRuntime();
    runtimes.push(runtime);
    const auth = runtime.objects.auth.singleton();
    await auth.applyScenarioFixture({
      users: [
        {
          id: "user-1",
          email: "admin@rejot.dev",
          role: "user",
          status: "active",
        },
      ],
    });

    const response = await callAction(createRequest(), "grant-secret", auth);

    assert(response.status === 200);
    await expect(response.json()).resolves.toEqual({ status: "granted", userId: "user-1" });
    await expect(auth.getUserAuthorityFacts({ userId: "user-1" })).resolves.toMatchObject({
      role: "admin",
    });
  });

  it("returns the email verification requirement", async () => {
    const grantBackofficeAdminByEmail = vi
      .fn<AuthObject["grantBackofficeAdminByEmail"]>()
      .mockResolvedValue({ status: "email_not_verified", userId: "user-1" });

    const response = await callAction(createRequest(), "grant-secret", {
      grantBackofficeAdminByEmail,
    });

    assert(response.status === 200);
    await expect(response.json()).resolves.toEqual({
      status: "email_not_verified",
      userId: "user-1",
    });
  });

  it("rejects invalid input before calling Auth", async () => {
    const grantBackofficeAdminByEmail = vi.fn<AuthObject["grantBackofficeAdminByEmail"]>();

    const response = await callAction(createRequest("grant-secret", {}), "grant-secret", {
      grantBackofficeAdminByEmail,
    });

    assert(response.status === 400);
    expect(grantBackofficeAdminByEmail).not.toHaveBeenCalled();
  });
});
