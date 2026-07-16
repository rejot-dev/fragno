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
import type { BillingEventInput } from "@/fragno/billing";

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
  test("stores events in the owning organization object", async () => {
    runtime = await createInMemoryBackofficeRuntime();

    const orgOneBilling = runtime.objects.billing.forOrg("org-1");
    const orgTwoBilling = runtime.objects.billing.forOrg("org-2");
    await runtime.drain();

    await expect(orgOneBilling.recordEvent(event())).resolves.toEqual({
      accepted: true,
      eventId: "pi:org-1:hook-1",
    });
    await expect(
      orgOneBilling.getTrackers({ scope: { kind: "org", orgId: "org-1" }, period: "2026-07" }),
    ).resolves.toMatchObject({
      trackers: [expect.objectContaining({ meter: "ai.tokens.total", quantity: "100" })],
      hasNextPage: false,
    });
    await expect(
      orgTwoBilling.getTrackers({ scope: { kind: "org", orgId: "org-2" }, period: "2026-07" }),
    ).resolves.toMatchObject({ trackers: [], hasNextPage: false });
  });

  test("allows user-scoped usage inside an organization billing object", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const billing = runtime.objects.billing.forOrg("org-1");
    await runtime.drain();
    const userScope = { kind: "user" as const, userId: "user-1" };

    await billing.recordEvent(
      event({
        id: "pi:org-1:user-1:hook-1",
        scope: userScope,
      }),
    );

    await expect(
      billing.getTrackers({ scope: userScope, period: "2026-07" }),
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
  });

  test("rejects event scopes belonging to another organization", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const billing = runtime.objects.billing.forOrg("org-1");
    await runtime.drain();

    await expect(
      billing.recordEvent(
        event({
          id: "pi:org-2:hook-1",
          scope: { kind: "org", orgId: "org-2" },
        }),
      ),
    ).rejects.toThrow("billing.record-event cannot use org:org-2 within org:org-1");
  });
});
