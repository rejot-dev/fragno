import { afterEach, assert, describe, expect, it, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { RouterContextProvider } from "react-router";

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import { action } from "./admin-grant";

const runtimes: InMemoryBackofficeRuntime[] = [];

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

function createRouteContext(runtime: InMemoryBackofficeRuntime) {
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, {
    runtime: runtime.services,
    kernel: new BackofficeKernel(runtime.services),
    env: {
      BACKOFFICE_INTERNAL_REQUEST_SECRET: runtime.env.BACKOFFICE_INTERNAL_REQUEST_SECRET,
    } as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

function callAction(request: Request, runtime: InMemoryBackofficeRuntime) {
  return action({
    request,
    url: new URL(request.url),
    context: createRouteContext(runtime),
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

async function createRuntime(configuredToken: string) {
  const runtime = await createInMemoryBackofficeRuntime({
    env: { AUTH_ADMIN_GRANT_TOKEN: configuredToken },
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.cleanup()));
});

describe("Backoffice administrator grant route", () => {
  it("is unavailable when the object host grant token is not configured", async () => {
    const runtime = await createRuntime("");
    const response = await callAction(createRequest(), runtime);

    assert(response.status === 404);
  });

  it("rejects an invalid grant token in the Auth object", async () => {
    const runtime = await createRuntime("grant-secret");
    const response = await callAction(createRequest("wrong-secret"), runtime);

    assert(response.status === 401);
  });

  it("rejects administrator access outside rejot.dev", async () => {
    const runtime = await createRuntime("grant-secret");
    const response = await callAction(
      createRequest("grant-secret", { email: "admin@example.com" }),
      runtime,
    );

    assert(response.status === 400);
    await expect(response.json()).resolves.toEqual({
      error: "Administrator access requires a @rejot.dev email address.",
    });
  });

  it("grants administrator access to the normalized email", async () => {
    const runtime = await createRuntime("grant-secret");
    const auth = runtime.objects.auth.singleton();
    await auth.commands.applyScenarioFixture({
      users: [
        {
          id: "user-1",
          email: "admin@rejot.dev",
          role: "user",
          status: "active",
        },
      ],
    });

    const response = await callAction(createRequest(), runtime);

    assert(response.status === 200);
    await expect(response.json()).resolves.toEqual({ status: "granted", userId: "user-1" });
    await expect(auth.commands.getUserAuthorityFacts({ userId: "user-1" })).resolves.toMatchObject({
      role: "admin",
    });
  });

  it("rejects invalid input before granting Auth administration", async () => {
    const runtime = await createRuntime("grant-secret");
    const response = await callAction(createRequest("grant-secret", {}), runtime);

    assert(response.status === 400);
  });
});
