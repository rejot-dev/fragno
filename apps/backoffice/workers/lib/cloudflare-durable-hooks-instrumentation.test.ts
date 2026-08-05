import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DurableHookAttempt } from "@fragno-dev/db/hooks";
import { FragnoId } from "@fragno-dev/db/schema";

const { enterSpan, setAttribute } = vi.hoisted(() => {
  const setAttribute = vi.fn();
  return {
    setAttribute,
    enterSpan: vi.fn((_name: string, callback: (span: unknown) => unknown) =>
      callback({ isTraced: true, setAttribute }),
    ),
  };
});

vi.mock("cloudflare:workers", () => ({ tracing: { enterSpan } }));

import { cloudflareDurableHooksInstrumentation } from "./cloudflare-durable-hooks-instrumentation";

const attempt: DurableHookAttempt = {
  namespace: "auth",
  hookId: FragnoId.fromExternal("hook-1", 0),
  hookName: "onOrganizationCreated",
  idempotencyKey: "nonce-1",
  attempt: 2,
  maxAttempts: 5,
  createdAt: new Date("2026-07-23T00:00:00.000Z"),
  propagationContext: {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
  },
};

describe("Cloudflare durable hooks instrumentation", () => {
  beforeEach(() => {
    enterSpan.mockClear();
    setAttribute.mockClear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("runs a notification once inside an attributed custom span", async () => {
    const execute = vi.fn(async () => "notified");

    await expect(
      cloudflareDurableHooksInstrumentation.runNotify?.(
        {
          namespace: "automations",
          correlationId: "producer-uow-1",
          source: "request",
          route: "/api/automations/events",
          crossNamespace: true,
          queued: 2,
        },
        execute,
      ),
    ).resolves.toBe("notified");

    expect(enterSpan).toHaveBeenCalledWith("fragno.durable_hooks.notify", expect.any(Function));
    expect(execute).toHaveBeenCalledOnce();
    expect(setAttribute.mock.calls).toEqual([
      ["fragno.hook.namespace", "automations"],
      ["fragno.hook.correlation_id", "producer-uow-1"],
      ["fragno.hook.notify.source", "request"],
      ["fragno.hook.notify.cross_namespace", true],
      ["fragno.hook.notify.queued", 2],
      ["fragno.hook.notify.route", "/api/automations/events"],
    ]);
  });

  test("runs an attempt once inside an attributed custom span", async () => {
    const execute = vi.fn(async () => "completed");

    await expect(cloudflareDurableHooksInstrumentation.runAttempt(attempt, execute)).resolves.toBe(
      "completed",
    );

    expect(enterSpan).toHaveBeenCalledWith("fragno.durable_hook.attempt", expect.any(Function));
    expect(execute).toHaveBeenCalledOnce();
    expect(setAttribute.mock.calls).toEqual([
      ["fragno.hook.namespace", "auth"],
      ["fragno.hook.name", "onOrganizationCreated"],
      ["fragno.hook.id", "hook-1"],
      ["fragno.hook.correlation_id", "nonce-1"],
      ["fragno.hook.attempt", 2],
      ["fragno.hook.max_attempts", 5],
      ["fragno.hook.has_propagation_context", true],
    ]);
    expect(console.info).toHaveBeenNthCalledWith(
      1,
      "fragno.durable_hook.attempt.started",
      expect.objectContaining({ hookName: "onOrganizationCreated", hookId: "hook-1" }),
    );
    expect(console.info).toHaveBeenNthCalledWith(
      2,
      "fragno.durable_hook.attempt.completed",
      expect.objectContaining({
        hookName: "onOrganizationCreated",
        durationMs: expect.any(Number),
      }),
    );
  });

  test("falls back to direct execution when the runtime skips the span callback", async () => {
    enterSpan.mockImplementationOnce(() => undefined);
    const execute = vi.fn(async () => "completed");

    await expect(cloudflareDurableHooksInstrumentation.runAttempt(attempt, execute)).resolves.toBe(
      "completed",
    );

    expect(execute).toHaveBeenCalledOnce();
  });

  test("falls back to direct execution when custom spans are unavailable", async () => {
    enterSpan.mockImplementationOnce(() => {
      throw new Error("custom spans unavailable");
    });
    const execute = vi.fn(async () => "completed");

    await expect(cloudflareDurableHooksInstrumentation.runAttempt(attempt, execute)).resolves.toBe(
      "completed",
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledTimes(2);
  });

  test("preserves attempt failures", async () => {
    const failure = new Error("hook failed");
    const execute = vi.fn(async () => {
      throw failure;
    });

    await expect(cloudflareDurableHooksInstrumentation.runAttempt(attempt, execute)).rejects.toBe(
      failure,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      "fragno.durable_hook.attempt.failed",
      expect.objectContaining({
        hookName: "onOrganizationCreated",
        errorName: "Error",
        errorMessage: "hook failed",
      }),
    );
  });
});
