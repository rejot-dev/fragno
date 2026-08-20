import { afterEach, assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";

import { piCapability } from "./pi";

const scope = { kind: "org" as const, orgId: "org-1" };

const capabilityContext = (runtime: InMemoryBackofficeRuntime) => ({
  objects: runtime.objects,
  config: runtime.config,
  scope,
  orgId: scope.orgId,
  origin: "https://backoffice.test",
});

describe("Pi capability", () => {
  let runtime: InMemoryBackofficeRuntime | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  test("reports unhealthy when no environment provider credentials exist", async () => {
    runtime = await createInMemoryBackofficeRuntime({
      env: {
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
      },
    });
    const connection = piCapability.contributions.connection;
    assert(connection);

    const status = await connection.getStatus(capabilityContext(runtime));

    expect(status).toMatchObject({
      configured: false,
      verification: { ok: false },
      missing: ["providerCredentials"],
    });
  });

  test("initializes Pi before exposing its hook repository", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const hookScope = piCapability.contributions.hookScopes.find(
      (candidate) => candidate.id === "pi",
    );
    assert(hookScope);

    const repository = await hookScope.getRepository(capabilityContext(runtime));
    const queue = await repository.getHookQueue();

    expect(queue).toMatchObject({ configured: true, hooksEnabled: true });
  });
});
