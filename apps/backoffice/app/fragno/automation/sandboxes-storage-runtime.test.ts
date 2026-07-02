import { describe, expect, test } from "vitest";

import { defineWorkflow } from "@fragno-dev/workflows/workflow";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { InMemoryAdapter } from "@fragno-dev/db";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import { createAutomationFragment } from "./index";
import { CLOUDFLARE_SANDBOX_PROVIDER, sandboxInstanceSchema } from "./sandboxes";

const createAutomation = (idSeed: string) => {
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
      mountRoute: "/api/automations-workflows",
    },
  );

  const automation = createAutomationFragment(
    {
      ownerScope: { kind: "org", orgId: "org_123" },
    },
    {
      databaseAdapter,
      dbRoundtripGuard: true,
      mountRoute: "/api/automations",
    },
    { workflows: workflows.services },
  );

  return { automation, workflows };
};

describe("automation sandbox instance services", () => {
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
    const { automation: fragment } = createAutomation("automation-sandbox-services-test");

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

  test("records sandbox lifecycle events in the automation event list", async () => {
    const { automation: fragment } = createAutomation("automation-sandbox-events-test");

    await fragment.callServices(() =>
      fragment.services.requestSandboxInstance({
        id: "org_123::dev",
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        sleepAfter: "15m",
      }),
    );

    await fragment.callServices(() =>
      fragment.services.markSandboxInstanceRunning({
        id: "org_123::dev",
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
        keepAlive: false,
        sleepAfter: "15m",
      }),
    );

    const eventPage = await fragment.callServices(() =>
      fragment.services.listEvents({ limit: 10 }),
    );

    expect(eventPage.events).toEqual([
      expect.objectContaining({
        scope: { kind: "org", orgId: "org_123" },
        source: "sandbox",
        eventType: "instance.ready",
        payload: expect.objectContaining({
          sandboxId: "org_123::dev",
          provider: CLOUDFLARE_SANDBOX_PROVIDER,
          status: "running",
        }),
        subject: expect.objectContaining({
          orgId: "org_123",
          sandboxId: "org_123::dev",
        }),
      }),
    ]);
  });
});
