import { describe, expect, test, vi } from "vitest";

import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import type { BackofficeObjectState } from "./backoffice-fragment-durable-object";
import { createScopedFragmentDurableObjectRuntime } from "./scoped-fragment-durable-object";

function createState(storageValues: Map<string, unknown>): BackofficeObjectState {
  return {
    storage: {
      get: async (key: string) => storageValues.get(key),
      put: async (key: string, value: unknown) => {
        storageValues.set(key, value);
      },
    } as BackofficeObjectState["storage"],
    blockConcurrencyWhile: async (callback) => await callback(),
    waitUntil: () => undefined,
  };
}

function createHost() {
  const alarm = vi.fn(async () => undefined);
  const initialize = vi.fn(async (source: { scopeId: string }) => ({ scopeId: source.scopeId }));
  return {
    alarm,
    initialize,
    host: {
      alarm,
      initialize,
      resolveMount: () => null,
      fetch: async () => new Response(null, { status: 404 }),
    } satisfies FragmentDurableObjectHost<{ scopeId: string }, { scopeId: string }>,
  };
}

describe("scoped fragment Durable Object runtime", () => {
  test("restores the dispatcher runtime before a cold alarm", async () => {
    const storage = new Map<string, unknown>();
    const warmHost = createHost();
    const warmState = createState(storage);
    const warmRuntime = createScopedFragmentDurableObjectRuntime({
      name: "Example",
      state: warmState,
      host: warmHost.host,
      createSource: (scope) => ({
        scopeId: scope.kind === "user" ? scope.userId : scope.orgId,
      }),
    });

    await warmState.blockConcurrencyWhile(
      async () => await warmRuntime.initializeFromStoredOwnerScope(),
    );
    warmRuntime.init({ kind: "org", orgId: "org-1" });
    await warmRuntime.getRuntime();

    const coldHost = createHost();
    const coldState = createState(storage);
    const coldRuntime = createScopedFragmentDurableObjectRuntime({
      name: "Example",
      state: coldState,
      host: coldHost.host,
      createSource: (scope) => ({
        scopeId: scope.kind === "user" ? scope.userId : scope.orgId,
      }),
    });

    await coldState.blockConcurrencyWhile(
      async () => await coldRuntime.initializeFromStoredOwnerScope(),
    );
    await coldRuntime.alarm();

    expect(coldHost.initialize).toHaveBeenCalledWith({ scopeId: "org-1" });
    expect(coldHost.alarm).toHaveBeenCalledOnce();
  });

  test("rejects an alarm when no owner scope was ever persisted", async () => {
    const host = createHost();
    const runtime = createScopedFragmentDurableObjectRuntime({
      name: "Example",
      state: createState(new Map()),
      host: host.host,
      createSource: () => ({ scopeId: "unused" }),
    });

    await expect(runtime.alarm()).rejects.toThrow(
      "Example alarm cannot run without persisted owner scope metadata.",
    );
    expect(host.alarm).not.toHaveBeenCalled();
  });
});
