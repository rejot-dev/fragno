import { describe, expect, it, assert, vi } from "vitest";

import type { DurableHooksInstrumentation, HookNotifyContext } from "../../hooks/hooks";
import type { AnyFragnoInstantiatedDatabaseFragment } from "../../mod";
import type { DurableHooksDispatcherDurableObjectHandler } from "./dispatcher";
import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHostOperations,
} from "./fragment-durable-object";

const createFragment = (name: string, hooks = true) =>
  ({
    name,
    $internal: hooks ? { durableHooksToken: {} } : {},
  }) as AnyFragnoInstantiatedDatabaseFragment;

const createFragmentWithOverrides = <T extends object>(name: string, overrides: T) =>
  Object.assign(createFragment(name), overrides);

type TestEnv = Record<string, never>;

type TestDispatcher = DurableHooksDispatcherDurableObjectHandler;

const createRecordingOperations = (dispatcher: TestDispatcher = {}) => {
  const migratedFragments: AnyFragnoInstantiatedDatabaseFragment[] = [];
  const dispatcherInputs: Array<{
    hookFragments: readonly AnyFragnoInstantiatedDatabaseFragment[];
    instrumentation: DurableHooksInstrumentation | undefined;
  }> = [];

  const operations: FragmentDurableObjectHostOperations<TestEnv> = {
    migrateFragment: async (fragment) => {
      migratedFragments.push(fragment);
    },
    createDispatcher: ({ hookFragments, instrumentation }) => {
      dispatcherInputs.push({ hookFragments, instrumentation });
      return dispatcher;
    },
  };

  return {
    operations,
    migratedFragments,
    dispatcherInputs,
  };
};

describe("createFragmentDurableObjectHost", () => {
  it("creates, migrates, and returns a hosted runtime", async () => {
    const fragment = createFragment("test");
    const runtimeBuilds: string[] = [];
    const recording = createRecordingOperations();

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: (source: { version: string }) => {
        runtimeBuilds.push(source.version);
        return { fragment };
      },
      getMigrationFragments: (runtime) => [runtime.fragment],
      operations: recording.operations,
    });

    const runtime = await host.initialize({ version: "v1" });

    expect(runtime).toEqual({ fragment });
    expect(runtimeBuilds).toEqual(["v1"]);
    expect(recording.migratedFragments).toEqual([fragment]);
    expect(recording.dispatcherInputs).toEqual([
      { hookFragments: [fragment], instrumentation: undefined },
    ]);
  });

  it("instruments runtime creation and each fragment migration", async () => {
    const first = createFragment("first");
    const second = createFragment("second");
    const recording = createRecordingOperations();
    const contexts: unknown[] = [];
    const host = createFragmentDurableObjectHost({
      name: "Automations",
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ first, second }),
      getMigrationFragments: (runtime) => [runtime.first, runtime.second],
      initializationInstrumentation: {
        run: <T>(context: unknown, execute: () => T): T => {
          contexts.push(context);
          return execute();
        },
      },
      operations: recording.operations,
    });

    await host.initialize({});

    expect(contexts).toEqual([
      { phase: "createRuntime", hostName: "Automations" },
      { phase: "migrate", hostName: "Automations", fragmentName: "first" },
      { phase: "migrate", hostName: "Automations", fragmentName: "second" },
    ]);
  });

  it("awaits durable hook alarm initialization before exposing the runtime", async () => {
    const fragment = createFragment("test");
    const dispatcherInitialization = Promise.withResolvers<void>();
    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => fragment,
      operations: createRecordingOperations({
        initialize: async () => await dispatcherInitialization.promise,
      }).operations,
    });

    const initialization = host.initialize({});
    let runtimeExposed = false;
    const runtimeExposure = initialization.then(() => {
      runtimeExposed = true;
    });

    await Promise.resolve();
    assert(!runtimeExposed);

    dispatcherInitialization.resolve();
    await runtimeExposure;
    assert(runtimeExposed);
  });

  it("creates a fresh runtime for every initialization", async () => {
    const runtimeBuilds: string[] = [];
    const recording = createRecordingOperations();

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: (source: { version: string }) => {
        runtimeBuilds.push(source.version);
        return { fragment: createFragment(source.version) };
      },
      getMigrationFragments: (runtime) => [runtime.fragment],
      operations: recording.operations,
    });

    const first = await host.initialize({ version: "v1" });
    const second = await host.initialize({ version: "v1" });

    expect(first).not.toBe(second);
    expect(runtimeBuilds).toEqual(["v1", "v1"]);
    expect(recording.migratedFragments.map((fragment) => fragment.name)).toEqual(["v1", "v1"]);
  });

  it("defaults migration fragments to the runtime when it is a fragment", async () => {
    const fragment = createFragment("test");
    const recording = createRecordingOperations();

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => fragment,
      operations: recording.operations,
    });

    const hosted = await host.initialize({});

    expect(hosted.name).toBe(fragment.name);
    expect(recording.migratedFragments).toEqual([fragment]);
    expect(recording.dispatcherInputs).toEqual([
      { hookFragments: [fragment], instrumentation: undefined },
    ]);
  });

  it("defaults hook fragments to migrated fragments with durable hooks configured", async () => {
    const hooksFragment = createFragment("hooks");
    const noHooksFragment = createFragment("no-hooks", false);
    const recording = createRecordingOperations();

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ hooksFragment, noHooksFragment }),
      getMigrationFragments: (runtime) => [runtime.hooksFragment, runtime.noHooksFragment],
      operations: recording.operations,
    });

    await host.initialize({});

    expect(recording.migratedFragments).toEqual([hooksFragment, noHooksFragment]);
    expect(recording.dispatcherInputs).toEqual([
      { hookFragments: [hooksFragment], instrumentation: undefined },
    ]);
  });

  it("passes host instrumentation to the durable hooks dispatcher", async () => {
    const fragment = createFragment("test");
    const recording = createRecordingOperations();
    const instrumentation: DurableHooksInstrumentation = {
      captureContext: () => null,
      runAttempt: async (_attempt, execute) => await execute(),
    };

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => fragment,
      durableHooksInstrumentation: instrumentation,
      operations: recording.operations,
    });

    await host.initialize({});

    expect(recording.dispatcherInputs).toEqual([{ hookFragments: [fragment], instrumentation }]);
  });

  it("wraps direct fragment calls to notify the durable hooks dispatcher", async () => {
    const routeCalls: unknown[][] = [];
    const notifications: HookNotifyContext[] = [];
    const fragment = createFragmentWithOverrides("test", {
      callRoute: async (...args: unknown[]) => {
        routeCalls.push(args);
        return "ok";
      },
    });
    const recording = createRecordingOperations({
      notify: async (context) => {
        notifications.push(context);
      },
    });

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => fragment,
      operations: recording.operations,
    });

    const hosted = await host.initialize({});
    const result = await hosted.callRoute("POST", "/test");

    expect(result).toBe("ok");
    expect(routeCalls).toEqual([["POST", "/test"]]);
    expect(notifications).toEqual([{ source: "request" }]);
  });

  it("dispatches fetch requests to mounted fragments", async () => {
    const calls: string[] = [];
    const workflowsFragment = createFragmentWithOverrides("workflows", {
      handler: async () => {
        calls.push("workflows");
        return new Response("workflows");
      },
    });
    const piFragment = createFragmentWithOverrides("pi", {
      handler: async () => {
        calls.push("pi");
        return new Response("pi");
      },
    });

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ workflowsFragment, piFragment }),
      getMigrationFragments: (runtime) => [runtime.workflowsFragment, runtime.piFragment],
      mounts: [
        {
          id: "workflows",
          match: ({ pathname }) => pathname.startsWith("/api/workflows"),
          target: (runtime) => runtime.workflowsFragment,
        },
        { id: "pi", target: (runtime) => runtime.piFragment },
      ],
      operations: createRecordingOperations().operations,
    });

    const runtime = await host.initialize({});

    const workflowsResponse = await host.fetch(
      runtime,
      new Request("https://example.com/api/workflows"),
    );
    const piResponse = await host.fetch(runtime, new Request("https://example.com/api/pi"));

    assert(workflowsResponse.status === 200);
    assert(piResponse.status === 200);
    expect(calls).toEqual(["workflows", "pi"]);
  });

  it("continues mount resolution after a matching mount returns no target", async () => {
    const calls: string[] = [];
    const fallbackFragment = createFragmentWithOverrides("fallback", {
      handler: async () => {
        calls.push("fallback");
        return new Response("fallback");
      },
    });

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ fallbackFragment }),
      getMigrationFragments: (runtime) => [runtime.fallbackFragment],
      mounts: [
        {
          id: "missing",
          match: ({ pathname }) => pathname.startsWith("/api"),
          target: () => null,
        },
        { id: "fallback", target: (runtime) => runtime.fallbackFragment },
      ],
      operations: createRecordingOperations().operations,
    });

    const runtime = await host.initialize({});
    const response = await host.fetch(runtime, new Request("https://example.com/api/test"));

    assert(response.status === 200);
    expect(calls).toEqual(["fallback"]);
  });

  it("passes propagation and application context to the mounted fragment", async () => {
    const lifecycleContexts: unknown[] = [];
    const fragment = createFragmentWithOverrides("test", {
      handler: async (_request: Request, context: unknown) => {
        lifecycleContexts.push(context);
        return new Response("ok");
      },
    });
    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => fragment,
      operations: createRecordingOperations().operations,
    });
    const runtime = await host.initialize({});
    const propagationContext = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
    };
    const requestContext = { executionId: "execution-1" };

    const response = await host.fetch(runtime, new Request("https://example.com/test"), {
      propagationContext,
      requestContext,
    });

    assert(response.status === 200);
    expect(lifecycleContexts).toEqual([{ propagationContext, requestContext }]);
  });

  it("can host fragments inside multi-fragment runtimes", async () => {
    const notifications: HookNotifyContext[] = [];
    const fragment = createFragmentWithOverrides("pi", {
      callRoute: async () => "ok",
    });

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ fragment }),
      getMigrationFragments: (runtime) => [runtime.fragment],
      hostRuntime: (runtime, { hostFragment }) => ({
        fragment: hostFragment(runtime.fragment),
      }),
      operations: createRecordingOperations({
        notify: async (context) => {
          notifications.push(context);
        },
      }).operations,
    });

    const runtime = await host.initialize({});
    await expect(runtime.fragment.callRoute()).resolves.toBe("ok");

    expect(notifications).toEqual([{ source: "request" }]);
  });

  it("delegates alarm to the latest durable hooks dispatcher", async () => {
    const firstFragment = createFragment("first");
    const secondFragment = createFragment("second");
    const alarmCalls: string[] = [];

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: (source: { name: string }) =>
        source.name === "first" ? firstFragment : secondFragment,
      operations: {
        migrateFragment: async () => {},
        createDispatcher: ({ hookFragments }) => ({
          alarm: async () => {
            alarmCalls.push(hookFragments[0]?.name ?? "unknown");
          },
        }),
      },
    });

    await host.initialize({ name: "first" });
    await host.initialize({ name: "second" });
    await host.alarm();

    expect(alarmCalls).toEqual(["second"]);
  });

  it("classifies dispatcher creation failures and rejects initialization", async () => {
    const fragment = createFragment("test");
    const dispatcherError = new Error("no hooks");
    const dispatcherErrors: unknown[] = [];
    const migrationErrors: unknown[] = [];
    const migratedFragments: AnyFragnoInstantiatedDatabaseFragment[] = [];

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ fragment }),
      getMigrationFragments: (runtime) => [runtime.fragment],
      onMigrationError: (error) => {
        migrationErrors.push(error);
      },
      onDispatcherError: (error) => {
        dispatcherErrors.push(error);
      },
      operations: {
        migrateFragment: async (migratedFragment) => {
          migratedFragments.push(migratedFragment);
        },
        createDispatcher: () => {
          throw dispatcherError;
        },
      },
    });

    await expect(host.initialize({})).rejects.toBe(dispatcherError);
    await expect(host.alarm()).resolves.toBeUndefined();

    expect(migratedFragments).toEqual([fragment]);
    expect(dispatcherErrors).toEqual([dispatcherError]);
    expect(migrationErrors).toEqual([]);
  });

  it("awaits dispatcher initialization error reporting without misclassifying the failure", async () => {
    const fragment = createFragment("test");
    const dispatcherError = new Error("alarm unavailable");
    const errorReporting = Promise.withResolvers<void>();
    const dispatcherErrors: unknown[] = [];
    const migrationErrors: unknown[] = [];
    const setBackgroundDrain = vi.fn();

    const host = createFragmentDurableObjectHost({
      state: {
        storage: { setAlarm: async () => {} },
        setBackgroundDrain,
      },
      env: {},
      createRuntime: () => fragment,
      onMigrationError: (error) => {
        migrationErrors.push(error);
      },
      onDispatcherError: async (error) => {
        dispatcherErrors.push(error);
        await errorReporting.promise;
      },
      operations: createRecordingOperations({
        initialize: async () => {
          throw dispatcherError;
        },
      }).operations,
    });

    let initializationCompleted = false;
    const initialization = host.initialize({}).finally(() => {
      initializationCompleted = true;
    });
    const initializationResult = expect(initialization).rejects.toBe(dispatcherError);
    await vi.waitFor(() => expect(dispatcherErrors).toEqual([dispatcherError]));
    assert(!initializationCompleted);

    errorReporting.resolve();
    await initializationResult;

    expect(migrationErrors).toEqual([]);
    expect(setBackgroundDrain).toHaveBeenLastCalledWith(null);
  });
});
