import { describe, expect, it, assert } from "vitest";

import type { HookNotifyContext } from "../../hooks/hooks";
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

type TestEnv = Record<string, never>;

type TestDispatcher = DurableHooksDispatcherDurableObjectHandler;

const createRecordingOperations = (dispatcher: TestDispatcher = {}) => {
  const migratedFragments: AnyFragnoInstantiatedDatabaseFragment[] = [];
  const dispatcherInputs: Array<readonly AnyFragnoInstantiatedDatabaseFragment[]> = [];

  const operations: FragmentDurableObjectHostOperations<TestEnv> = {
    migrateFragment: async (fragment) => {
      migratedFragments.push(fragment);
    },
    createDispatcher: ({ hookFragments }) => {
      dispatcherInputs.push(hookFragments);
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
    expect(recording.dispatcherInputs).toEqual([[fragment]]);
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
    expect(recording.dispatcherInputs).toEqual([[fragment]]);
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
    expect(recording.dispatcherInputs).toEqual([[hooksFragment]]);
  });

  it("wraps direct fragment calls to notify the durable hooks dispatcher", async () => {
    const routeCalls: unknown[][] = [];
    const notifications: HookNotifyContext[] = [];
    const fragment = {
      ...createFragment("test"),
      callRoute: async (...args: unknown[]) => {
        routeCalls.push(args);
        return "ok";
      },
    } as unknown as AnyFragnoInstantiatedDatabaseFragment & {
      callRoute: (...args: unknown[]) => Promise<string>;
    };
    const recording = createRecordingOperations({
      notify: (context) => {
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
    const workflowsFragment = {
      ...createFragment("workflows"),
      handler: async () => {
        calls.push("workflows");
        return new Response("workflows");
      },
    } as unknown as AnyFragnoInstantiatedDatabaseFragment & {
      handler: (request: Request) => Promise<Response>;
    };
    const piFragment = {
      ...createFragment("pi"),
      handler: async () => {
        calls.push("pi");
        return new Response("pi");
      },
    } as unknown as AnyFragnoInstantiatedDatabaseFragment & {
      handler: (request: Request) => Promise<Response>;
    };

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
    const fallbackFragment = {
      ...createFragment("fallback"),
      handler: async () => {
        calls.push("fallback");
        return new Response("fallback");
      },
    } as unknown as AnyFragnoInstantiatedDatabaseFragment & {
      handler: (request: Request) => Promise<Response>;
    };

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

  it("can host fragments inside multi-fragment runtimes", async () => {
    const notifications: HookNotifyContext[] = [];
    const fragment = {
      ...createFragment("pi"),
      callRoute: async () => "ok",
    } as unknown as AnyFragnoInstantiatedDatabaseFragment & {
      callRoute: () => Promise<string>;
    };

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ fragment }),
      getMigrationFragments: (runtime) => [runtime.fragment],
      hostRuntime: (runtime, { hostFragment }) => ({
        fragment: hostFragment(runtime.fragment),
      }),
      operations: createRecordingOperations({
        notify: (context) => {
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

  it("disables dispatcher creation failures without failing migration", async () => {
    const fragment = createFragment("test");
    const dispatcherError = new Error("no hooks");
    const dispatcherErrors: unknown[] = [];
    const migratedFragments: AnyFragnoInstantiatedDatabaseFragment[] = [];

    const host = createFragmentDurableObjectHost({
      state: { storage: { setAlarm: async () => {} } },
      env: {},
      createRuntime: () => ({ fragment }),
      getMigrationFragments: (runtime) => [runtime.fragment],
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

    await expect(host.initialize({})).resolves.toEqual({ fragment });
    await expect(host.alarm()).resolves.toBeUndefined();

    expect(migratedFragments).toEqual([fragment]);
    expect(dispatcherErrors).toEqual([dispatcherError]);
  });
});
