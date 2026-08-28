import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return {
    DurableObject: MockDurableObject,
    RpcTarget: class {},
    WorkerEntrypoint: class {},
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";

let runtime: InMemoryBackofficeRuntime | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
});

afterEach(async () => {
  try {
    await runtime?.cleanup();
    runtime = null;
  } finally {
    vi.useRealTimers();
  }
});

async function listFormsAutomationEvents(runtime: InMemoryBackofficeRuntime) {
  const response = await runtime.objects.automations
    .singleton()
    .http.fetch(new Request("https://automations.test/api/automations/events?limit=10"));
  assert(response.ok);
  return (await response.json()) as {
    events: Array<{ eventType: string; occurredAt: string }>;
  };
}

describe("Forms Durable Object events", () => {
  test("preserves form creation and deletion times across delayed durable hook delivery", async () => {
    runtime = await createInMemoryBackofficeRuntime();
    const forms = runtime.objects.forms.singleton();
    await runtime.drain();

    const createdAt = new Date().toISOString();
    const createResponse = await forms.http.fetch(
      new Request("https://forms.test/api/forms/admin/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Delayed lifecycle form",
          slug: "delayed-lifecycle-form",
          description: null,
          status: "draft",
          dataSchema: { type: "object" },
        }),
      }),
    );
    assert(createResponse.ok);
    const formId = (await createResponse.json()) as string;

    vi.setSystemTime(new Date("2026-08-27T12:05:00.000Z"));
    runtime.advanceTime(5 * 60 * 1000);
    await runtime.drain();

    const createdEvent = (await listFormsAutomationEvents(runtime)).events.find(
      (event) => event.eventType === "form.created",
    );
    expect(createdEvent?.occurredAt).toBe(createdAt);

    const deletedAt = new Date().toISOString();
    const deleteResponse = await forms.http.fetch(
      new Request(`https://forms.test/api/forms/admin/forms/${formId}`, { method: "DELETE" }),
    );
    assert(deleteResponse.ok);

    vi.setSystemTime(new Date("2026-08-27T12:10:00.000Z"));
    runtime.advanceTime(5 * 60 * 1000);
    await runtime.drain();

    const deletedEvent = (await listFormsAutomationEvents(runtime)).events.find(
      (event) => event.eventType === "form.deleted",
    );
    expect(deletedEvent?.occurredAt).toBe(deletedAt);
  });
});
