import { describe, expect, test } from "vitest";

import { defineWorkflow } from "@fragno-dev/workflows/workflow";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { InMemoryAdapter } from "@fragno-dev/db";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import { CLOUDFLARE_SANDBOX_PROVIDER, sandboxInstanceSchema } from "./contracts";
import { createSandboxManagerFragment } from "./sandbox-manager-fragment";

function createSandboxManager(idSeed: string) {
  const databaseAdapter = new InMemoryAdapter({ idSeed });
  const workflows = createWorkflowsFragment(
    {
      workflows: {
        SANDBOX_LIFECYCLE: defineWorkflow({ name: "sandbox-lifecycle" }, () => undefined),
      },
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter,
      dbRoundtripGuard: true,
      mountRoute: "/api/workflows",
    },
  );

  const sandboxManager = createSandboxManagerFragment(
    {
      sandboxProviders: {},
      deliverLifecycleEvent: async () => undefined,
    },
    {
      databaseAdapter,
      dbRoundtripGuard: true,
      mountRoute: "/api/sandbox-manager",
    },
    { workflows: workflows.services },
  );

  return { sandboxManager, workflows };
}

describe("sandbox manager instance services", () => {
  test("rejects invalid persisted sandbox timestamps", () => {
    expect(() =>
      sandboxInstanceSchema.parse({
        id: "org_123::dev",
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        status: "running",
        workflowInstanceId: "workflow-1",
        keepAlive: false,
        sleepAfter: null,
        startupCommand: "true",
        startupTimeoutMs: 15_000,
        startedAt: new Date(Number.NaN),
        expectedStopAt: null,
        stoppedAt: null,
        lastError: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      }),
    ).toThrow();
  });

  test("requests, lists, gets, and updates sandbox lifecycle status", async () => {
    const { sandboxManager: fragment } = createSandboxManager("sandbox-manager-services-test");

    const created = await fragment.callServices(() =>
      fragment.services.requestSandboxInstance({
        id: "org_123::dev",
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        sleepAfter: "15m",
        startupCommand: "true",
      }),
    );

    expect(created).toMatchObject({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      status: "requested",
      keepAlive: false,
      sleepAfter: "15m",
      startupCommand: "true",
    });
    expect(created.workflowInstanceId).toMatch(/^inst_/u);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    await fragment.callServices(() =>
      fragment.services.requestSandboxInstance({
        id: "org_123::other",
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
      }),
    );

    const listed = await fragment.callServices(() =>
      fragment.services.listSandboxInstances({ provider: CLOUDFLARE_SANDBOX_PROVIDER }),
    );
    expect(listed.map((instance) => instance.id).sort()).toEqual([
      "org_123::dev",
      "org_123::other",
    ]);
    const persistedCreated = listed.find((instance) => instance.id === "org_123::dev");
    expect(persistedCreated).toBeDefined();

    const duplicate = await fragment.callServices(() =>
      fragment.services.requestSandboxInstance({
        id: "org_123::dev",
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        keepAlive: true,
      }),
    );
    expect(duplicate).toMatchObject({
      id: "org_123::dev",
      status: "requested",
      workflowInstanceId: created.workflowInstanceId,
      keepAlive: false,
      startupCommand: "true",
    });
    expect(duplicate.createdAt).toEqual(persistedCreated!.createdAt);
    expect(duplicate.updatedAt).toEqual(persistedCreated!.updatedAt);

    await fragment.callServices(() =>
      fragment.services.markSandboxInstanceStarting({ id: "org_123::dev" }),
    );
    await expect(
      fragment.callServices(() => fragment.services.getSandboxInstance({ id: "org_123::dev" })),
    ).resolves.toMatchObject({
      id: "org_123::dev",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      status: "starting",
    });
  });
});
