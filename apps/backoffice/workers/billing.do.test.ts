import { afterEach, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { BackofficeRpcContext } from "@/backoffice-runtime/object-registry";
import type { BillingEventInput } from "@/fragno/billing";

import { Billing, InMemoryBillingObject } from "./billing.do";

let runtime: InMemoryBackofficeRuntime | null = null;

const event = (overrides: Partial<BillingEventInput> = {}): BillingEventInput => ({
  id: "pi:org-1:hook-1",
  scope: { kind: "org", orgId: "org-1" },
  source: "pi-harness",
  eventType: "operation.completed",
  occurredAt: "2026-07-16T12:00:00.000Z",
  measurements: [{ meter: "ai.tokens.total", unit: "token", quantity: 100 }],
  ...overrides,
});

afterEach(async () => {
  await runtime?.cleanup();
  runtime = null;
});

describe("Billing Durable Object", () => {
  test("forwards RPC propagation context through the production wrapper", async () => {
    const result = { accepted: true, eventId: "pi:org-1:hook-1" } as const;
    const recordEvent = vi
      .spyOn(InMemoryBillingObject.prototype, "recordEvent")
      .mockResolvedValue(result);
    const state = {
      id: { name: "v1:org:org-1" },
      blockConcurrencyWhile: vi.fn(async () => undefined),
    } as unknown as DurableObjectState;
    const context: BackofficeRpcContext = {
      propagationContext: { traceId: "billing-trace" },
    };
    const billing = new Billing(state, {} as CloudflareEnv);

    try {
      await expect(billing.recordEvent(event(), context)).resolves.toEqual(result);
      expect(recordEvent).toHaveBeenCalledWith(event(), context);
    } finally {
      recordEvent.mockRestore();
    }
  });

  test("stores events in the owning organization object", async () => {
    runtime = await createInMemoryBackofficeRuntime();

    const orgOneBilling = runtime.objects.billing.forOrg("org-1");
    const orgTwoBilling = runtime.objects.billing.forOrg("org-2");
    await runtime.drain();

    await expect(orgOneBilling.commands.recordEvent(event())).resolves.toEqual({
      accepted: true,
      eventId: "pi:org-1:hook-1",
    });
    await expect(
      orgOneBilling.commands.getTrackers({
        scope: { kind: "org", orgId: "org-1" },
        period: "2026-07",
      }),
    ).resolves.toMatchObject({
      trackers: [expect.objectContaining({ meter: "ai.tokens.total", quantity: "100" })],
      hasNextPage: false,
    });
    await expect(
      orgTwoBilling.commands.getTrackers({
        scope: { kind: "org", orgId: "org-2" },
        period: "2026-07",
      }),
    ).resolves.toMatchObject({ trackers: [], hasNextPage: false });
  });

  test("allows user-scoped usage inside an organization billing object", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const billing = runtime.objects.billing.forOrg("org-1");
    await runtime.drain();
    const userScope = { kind: "user" as const, userId: "user-1" };

    await billing.commands.recordEvent(
      event({
        id: "pi:org-1:user-1:hook-1",
        scope: userScope,
      }),
    );
    await billing.commands.recordEvent(
      event({
        id: "pi:org-1:project-1:hook-1",
        scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
        measurements: [{ meter: "ai.tokens.total", unit: "token", quantity: 40 }],
      }),
    );

    await expect(
      billing.commands.getTrackers({ scope: userScope, period: "2026-07" }),
    ).resolves.toMatchObject({
      trackers: [
        expect.objectContaining({
          scope: userScope,
          meter: "ai.tokens.total",
          quantity: "100",
        }),
      ],
      hasNextPage: false,
    });
    await expect(billing.commands.getStatement({ period: "2026-07" })).resolves.toMatchObject({
      period: "2026-07",
      trackers: [
        expect.objectContaining({
          meter: "ai.tokens.total",
          quantity: "140",
          eventCount: "2",
        }),
      ],
    });
  });

  test("records usage attribution independently from the ledger owner", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const billing = runtime.objects.billing.forOrg("org-1");
    await runtime.drain();

    await expect(
      billing.commands.recordEvent(
        event({
          id: "pi:system:hook-1",
          scope: { kind: "system" },
        }),
      ),
    ).resolves.toEqual({ accepted: true, eventId: "pi:system:hook-1" });
  });
});
