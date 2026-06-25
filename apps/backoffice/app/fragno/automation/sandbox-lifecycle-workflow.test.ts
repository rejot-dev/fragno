import { describe, expect, test, vi, assert } from "vitest";

import {
  defineScenario,
  runScenario,
  type WorkflowScenarioHarnessOptions,
} from "@fragno-dev/workflows/scenario";

import { instantiate, type InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import type { TestDb } from "@fragno-dev/test";

import type { SandboxRuntimeHandle, SandboxRuntimeProvider } from "@/sandbox/contracts";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";

import { automationFragmentDefinition } from "./definition";
import { defineSandboxLifecycleWorkflow } from "./sandbox-lifecycle-workflow";
import type { SandboxLifecycleWorkflowParams } from "./sandboxes-storage-runtime";
import { automationFragmentSchema } from "./schema";

type AutomationFragment = InstantiatedFragmentFromDefinition<typeof automationFragmentDefinition>;

const defaultParams = (overrides: Partial<SandboxLifecycleWorkflowParams> = {}) =>
  ({
    id: "org_123::dev",
    provider: CLOUDFLARE_SANDBOX_PROVIDER,
    keepAlive: false,
    sleepAfter: "10m",
    startupCommand: "pnpm install",
    startupTimeoutMs: 12_000,
    ...overrides,
  }) satisfies SandboxLifecycleWorkflowParams;

const createRuntimeHandle = (overrides: Partial<ReturnType<typeof baseRuntimeHandle>> = {}) => ({
  ...baseRuntimeHandle(),
  ...overrides,
});

const baseRuntimeHandle = () => ({
  exec: vi.fn(async () => ({ success: true, stdout: "ready", stderr: "", exitCode: 0 })),
  destroy: vi.fn(async () => undefined),
  mountBucket: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  exists: vi.fn(async () => ({ exists: true })),
  getRuntimeStatus: vi.fn(async () => ({ status: "running" as const })),
});

const createProvider = (
  handle: ReturnType<typeof createRuntimeHandle>,
  overrides: Partial<SandboxRuntimeProvider> = {},
) =>
  ({
    provider: CLOUDFLARE_SANDBOX_PROVIDER,
    getHandle: vi.fn(async () => handle as unknown as SandboxRuntimeHandle),
    getStatus: vi.fn(async () => "running" as const),
    ...overrides,
  }) satisfies SandboxRuntimeProvider;

const seedSandboxInstance = async (
  ctx: { harness: { db: TestDb }; clock: { now: () => Date } },
  params: SandboxLifecycleWorkflowParams,
  workflowInstanceId: string,
) => {
  const uow = ctx.harness.db
    .createUnitOfWork("seed-sandbox-instance")
    .forSchema(automationFragmentSchema);
  const now = ctx.clock.now();
  uow.create("sandbox_instance", {
    id: params.id,
    provider: params.provider,
    status: "requested" as const,
    workflowInstanceId,
    keepAlive: params.keepAlive ?? false,
    sleepAfter: params.sleepAfter ?? null,
    startupCommand: params.startupCommand || "true",
    startupTimeoutMs: params.startupTimeoutMs ?? 15_000,
    startedAt: null,
    expectedStopAt: null,
    stoppedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  const { success } = await uow.executeMutations();
  assert(success);
};

const readSandboxInstance = async (db: TestDb, id: string) => {
  const [row] = await db
    .createUnitOfWork("read-sandbox-instance")
    .forSchema(automationFragmentSchema)
    .findFirst("sandbox_instance", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)))
    .executeRetrieve();
  return row;
};

const createLifecycleWorkflows = ({
  provider,
  getAutomationFragment,
  sandboxProviders,
}: {
  provider?: SandboxRuntimeProvider;
  getAutomationFragment: () => AutomationFragment | undefined;
  sandboxProviders?: Record<string, SandboxRuntimeProvider>;
}) => ({
  SANDBOX_LIFECYCLE: defineSandboxLifecycleWorkflow({
    sandboxProviders:
      sandboxProviders ?? (provider ? { [CLOUDFLARE_SANDBOX_PROVIDER]: provider } : {}),
    getAutomationFragment,
  }),
});

const automationScenarioHarness = {
  configureFragments: ((harness) => ({
    automations: instantiate(automationFragmentDefinition)
      .withConfig({ ownerScope: { kind: "org", orgId: "org_123" } })
      .withServices({ workflows: harness.fragment.services }),
  })) satisfies NonNullable<
    WorkflowScenarioHarnessOptions<
      ReturnType<typeof createLifecycleWorkflows>
    >["configureFragments"]
  >,
};

describe("sandbox lifecycle workflow", () => {
  test("starts a sandbox and stops it when the stop event arrives", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ sleepAfter: "10m" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-stop-event",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-stop-1");
            },
          }),
          workflow.create({ workflow: "SANDBOX_LIFECYCLE", id: "sandbox-stop-1", params }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-stop-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) => readSandboxInstance(ctx.harness.db, params.id),
            assert: (row) => {
              expect(row).toMatchObject({ status: "running", lastError: null });
              expect(row?.startedAt).toBeInstanceOf(Date);
              expect(row?.expectedStopAt).toBeInstanceOf(Date);
              expect(row?.stoppedAt).toBeNull();
            },
          }),
          workflow.read({
            read: (ctx) => ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-stop-1"),
            assert: (status) => {
              assert(status?.status === "waiting");
            },
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                await ctx.harness.sendEvent("sandbox-lifecycle", "sandbox-stop-1", {
                  type: "sandbox.stopRequested",
                  payload: { sandboxId: params.id },
                });
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: "sandbox-stop-1",
                  reason: "event",
                });
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-stop-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
              steps: await ctx.state.getSteps("SANDBOX_LIFECYCLE", "sandbox-stop-1"),
            }),
            assert: ({ status, row, steps }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { sandboxId: params.id, stopReason: "stop request" },
              });
              expect(row).toMatchObject({ status: "stopped", lastError: null });
              expect(row?.stoppedAt).toBeInstanceOf(Date);
              expect(steps).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    stepKey: "waitForEvent:sandbox stop requested",
                    status: "completed",
                  }),
                ]),
              );
            },
          }),
        ],
      }),
    );

    expect(provider.getHandle).toHaveBeenCalledWith(params.id, {
      keepAlive: false,
      sleepAfter: "10m",
    });
    expect(handle.exec).toHaveBeenCalledWith("pnpm install", { timeout: 12_000 });
    expect(provider.getStatus).toHaveBeenCalledWith(params.id);
    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  test("stops a sandbox when waitForEvent times out", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::timeout", sleepAfter: "10s" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-timeout",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-timeout-1");
            },
          }),
          workflow.create({ workflow: "SANDBOX_LIFECYCLE", id: "sandbox-timeout-1", params }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-timeout-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: async (ctx) => {
              ctx.clock.advanceBy("11 seconds");
              await ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-timeout-1",
                reason: "wake",
              });
            },
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-timeout-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
              steps: await ctx.state.getSteps("SANDBOX_LIFECYCLE", "sandbox-timeout-1"),
            }),
            assert: ({ status, row, steps }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { sandboxId: params.id, stopReason: "timeout" },
              });
              expect(row).toMatchObject({ status: "stopped", lastError: null });
              expect(row?.stoppedAt).toBeInstanceOf(Date);
              expect(steps).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    stepKey: "waitForEvent:sandbox stop requested",
                    status: "errored",
                    errorMessage: "WAIT_FOR_EVENT_TIMEOUT",
                  }),
                ]),
              );
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  test("keepAlive true waits indefinitely until a stop event arrives", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::keepalive", keepAlive: true, sleepAfter: "10s" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-keepalive",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-keepalive-1");
            },
          }),
          workflow.create({ workflow: "SANDBOX_LIFECYCLE", id: "sandbox-keepalive-1", params }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-keepalive-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: async (ctx) => {
              ctx.clock.advanceBy("1 hour");
              await ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-keepalive-1",
                reason: "wake",
              });
              return {
                status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-keepalive-1"),
                row: await readSandboxInstance(ctx.harness.db, params.id),
              };
            },
            assert: ({ status, row }) => {
              assert(status?.status === "waiting");
              expect(row).toMatchObject({ status: "running", expectedStopAt: null });
            },
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                await ctx.harness.sendEvent("sandbox-lifecycle", "sandbox-keepalive-1", {
                  type: "sandbox.stopRequested",
                  payload: { sandboxId: params.id },
                });
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: "sandbox-keepalive-1",
                  reason: "event",
                });
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-keepalive-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { sandboxId: params.id, stopReason: "stop request" },
              });
              expect(row).toMatchObject({ status: "stopped" });
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  test("omitting sleepAfter waits indefinitely until a stop event arrives", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::no-sleep", sleepAfter: undefined });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-no-sleep-after",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-no-sleep-1");
            },
          }),
          workflow.create({ workflow: "SANDBOX_LIFECYCLE", id: "sandbox-no-sleep-1", params }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-no-sleep-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: async (ctx) => {
              ctx.clock.advanceBy("1 hour");
              await ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-no-sleep-1",
                reason: "wake",
              });
              return {
                status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-no-sleep-1"),
                row: await readSandboxInstance(ctx.harness.db, params.id),
              };
            },
            assert: ({ status, row }) => {
              assert(status?.status === "waiting");
              expect(row).toMatchObject({ status: "running", expectedStopAt: null });
            },
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                await ctx.harness.sendEvent("sandbox-lifecycle", "sandbox-no-sleep-1", {
                  type: "sandbox.stopRequested",
                  payload: { sandboxId: params.id },
                });
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: "sandbox-no-sleep-1",
                  reason: "event",
                });
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-no-sleep-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { sandboxId: params.id, stopReason: "stop request" },
              });
              expect(row).toMatchObject({ status: "stopped" });
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  test("startup command failure retries and eventually marks the sandbox error", async () => {
    const handle = createRuntimeHandle({
      exec: vi.fn(async () => ({ success: false, stdout: "", stderr: "boom", exitCode: 1 })),
    });
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::startup-command-fails" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-startup-command-error",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-startup-command-error-1");
            },
          }),
          workflow.create({
            workflow: "SANDBOX_LIFECYCLE",
            id: "sandbox-startup-command-error-1",
            params,
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-startup-command-error-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                for (let attempt = 0; attempt < 10; attempt += 1) {
                  ctx.clock.advanceBy("24 hours");
                  await ctx.harness.runUntilIdle({
                    workflowName: "sandbox-lifecycle",
                    instanceId: "sandbox-startup-command-error-1",
                    reason: "retry",
                  });
                }
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(
                "SANDBOX_LIFECYCLE",
                "sandbox-startup-command-error-1",
              ),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({ status: "errored" });
              expect(row).toMatchObject({
                status: "error",
                lastError: "Sandbox startup failed after retries.",
              });
            },
          }),
        ],
      }),
    );

    expect(handle.exec).toHaveBeenCalledTimes(11);
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(handle.destroy).not.toHaveBeenCalled();
  });

  test("provider getHandle startup failure retries and eventually marks the sandbox error", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle, {
      getHandle: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });
    const params = defaultParams({ id: "org_123::provider-startup-fails" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-provider-startup-error",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-provider-startup-error-1");
            },
          }),
          workflow.create({
            workflow: "SANDBOX_LIFECYCLE",
            id: "sandbox-provider-startup-error-1",
            params,
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-provider-startup-error-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                for (let attempt = 0; attempt < 10; attempt += 1) {
                  ctx.clock.advanceBy("24 hours");
                  await ctx.harness.runUntilIdle({
                    workflowName: "sandbox-lifecycle",
                    instanceId: "sandbox-provider-startup-error-1",
                    reason: "retry",
                  });
                }
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus(
                "SANDBOX_LIFECYCLE",
                "sandbox-provider-startup-error-1",
              ),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({ status: "errored" });
              expect(row).toMatchObject({
                status: "error",
                lastError: "Sandbox startup failed after retries.",
              });
            },
          }),
        ],
      }),
    );

    expect(provider.getHandle).toHaveBeenCalledTimes(11);
    expect(handle.exec).not.toHaveBeenCalled();
    expect(provider.getStatus).not.toHaveBeenCalled();
  });

  test("stop reconciliation skips destroy when provider status is already stopped", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle, {
      getStatus: vi.fn(async () => "stopped" as const),
    });
    const params = defaultParams({ id: "org_123::already-stopped" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-provider-already-stopped",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-already-stopped-1");
            },
          }),
          workflow.create({
            workflow: "SANDBOX_LIFECYCLE",
            id: "sandbox-already-stopped-1",
            params,
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-already-stopped-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                await ctx.harness.sendEvent("sandbox-lifecycle", "sandbox-already-stopped-1", {
                  type: "sandbox.stopRequested",
                  payload: { sandboxId: params.id },
                });
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: "sandbox-already-stopped-1",
                  reason: "event",
                });
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-already-stopped-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({ status: "complete" });
              expect(row).toMatchObject({ status: "stopped" });
            },
          }),
        ],
      }),
    );

    expect(provider.getStatus).toHaveBeenCalledWith(params.id);
    expect(handle.destroy).not.toHaveBeenCalled();
  });

  test("stop reconciliation treats known terminated destroy errors as already stopped", async () => {
    const handle = createRuntimeHandle({
      destroy: vi.fn(async () => {
        throw new Error("sandbox has been destroyed");
      }),
    });
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::known-terminated" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-known-terminated-destroy",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-known-terminated-1");
            },
          }),
          workflow.create({
            workflow: "SANDBOX_LIFECYCLE",
            id: "sandbox-known-terminated-1",
            params,
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-known-terminated-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                await ctx.harness.sendEvent("sandbox-lifecycle", "sandbox-known-terminated-1", {
                  type: "sandbox.stopRequested",
                  payload: { sandboxId: params.id },
                });
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: "sandbox-known-terminated-1",
                  reason: "event",
                });
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-known-terminated-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({ status: "complete" });
              expect(row).toMatchObject({ status: "stopped" });
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  test("stop reconciliation retries unknown destroy errors and eventually marks error", async () => {
    const handle = createRuntimeHandle({
      destroy: vi.fn(async () => {
        throw new Error("network exploded");
      }),
    });
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::destroy-fails" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-destroy-error",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-destroy-error-1");
            },
          }),
          workflow.create({ workflow: "SANDBOX_LIFECYCLE", id: "sandbox-destroy-error-1", params }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-destroy-error-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                await ctx.harness.sendEvent("sandbox-lifecycle", "sandbox-destroy-error-1", {
                  type: "sandbox.stopRequested",
                  payload: { sandboxId: params.id },
                });
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: "sandbox-destroy-error-1",
                  reason: "event",
                });
              })(),
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                for (let attempt = 0; attempt < 10; attempt += 1) {
                  ctx.clock.advanceBy("24 hours");
                  await ctx.harness.runUntilIdle({
                    workflowName: "sandbox-lifecycle",
                    instanceId: "sandbox-destroy-error-1",
                    reason: "retry",
                  });
                }
              })(),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-destroy-error-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({ status: "errored" });
              expect(row).toMatchObject({
                status: "error",
                lastError: "Sandbox stop reconciliation failed after retries.",
              });
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).toHaveBeenCalledTimes(11);
  });

  test("missing provider config errors before marking the sandbox starting", async () => {
    const params = defaultParams({ id: "org_123::missing-provider" });
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      getAutomationFragment: () => automationFragment,
      sandboxProviders: {},
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-missing-provider",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-missing-provider-1");
            },
          }),
          workflow.create({
            workflow: "SANDBOX_LIFECYCLE",
            id: "sandbox-missing-provider-1",
            params,
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-missing-provider-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-missing-provider-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({
                status: "errored",
                error: { message: "No sandbox provider configured for 'cloudflare'." },
              });
              expect(row).toMatchObject({ status: "requested", startedAt: null, stoppedAt: null });
            },
          }),
        ],
      }),
    );
  });

  test("missing automations fragment errors with a clear configuration message", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::missing-fragment" });
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => undefined,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-missing-automation-fragment",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              await seedSandboxInstance(ctx, params, "sandbox-missing-fragment-1");
            },
          }),
          workflow.create({
            workflow: "SANDBOX_LIFECYCLE",
            id: "sandbox-missing-fragment-1",
            params,
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-missing-fragment-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: async (ctx) => ({
              status: await ctx.state.getStatus("SANDBOX_LIFECYCLE", "sandbox-missing-fragment-1"),
              row: await readSandboxInstance(ctx.harness.db, params.id),
            }),
            assert: ({ status, row }) => {
              expect(status).toMatchObject({
                status: "errored",
                error: {
                  message: "Sandbox lifecycle workflow requires the automations fragment.",
                },
              });
              expect(row).toMatchObject({ status: "requested", startedAt: null, stoppedAt: null });
            },
          }),
        ],
      }),
    );

    expect(handle.exec).not.toHaveBeenCalled();
  });

  test("stale stop events from a superseded lifecycle do not stop the current sandbox", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::duplicate-start", keepAlive: true });
    let automationFragment: AutomationFragment | undefined;
    let firstWorkflowInstanceId = "";
    let secondWorkflowInstanceId = "";
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-superseded-stop-event",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              const first = await automationFragment.callServices(() =>
                automationFragment!.services.requestSandboxInstance(params),
              );
              firstWorkflowInstanceId = first.workflowInstanceId ?? "";
            },
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: firstWorkflowInstanceId,
                reason: "create",
              }),
          }),
          workflow.read({
            read: async (ctx) => {
              secondWorkflowInstanceId = "manual-current-lifecycle";
              const uow = ctx.harness.db
                .createUnitOfWork("supersede-sandbox-lifecycle")
                .forSchema(automationFragmentSchema);
              uow.update("sandbox_instance", params.id, (b) =>
                b.set({
                  workflowInstanceId: secondWorkflowInstanceId,
                  startupCommand: "echo second",
                  updatedAt: ctx.clock.now(),
                }),
              );
              const { success } = await uow.executeMutations();
              assert(success);
            },
          }),
          workflow.read({
            read: async (ctx) => {
              await ctx.harness.sendEvent("sandbox-lifecycle", firstWorkflowInstanceId, {
                type: "sandbox.stopRequested",
                payload: { sandboxId: params.id },
              });
              await ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: firstWorkflowInstanceId,
                reason: "event",
              });
            },
          }),
          workflow.read({
            read: (ctx) => readSandboxInstance(ctx.harness.db, params.id),
            assert: (row) => {
              expect(row).toMatchObject({
                status: "running",
                workflowInstanceId: secondWorkflowInstanceId,
                startupCommand: "echo second",
              });
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).not.toHaveBeenCalled();
  });

  test("terminal workflow hooks reconcile physical sandboxes", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::terminal-but-running", keepAlive: true });
    let automationFragment: AutomationFragment | undefined;
    let workflowInstanceId = "";
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-terminal-workflow-physical-reconcile",
        workflows,
        harness: {
          ...automationScenarioHarness,
          configureFragments: ((harness) => ({
            automations: instantiate(automationFragmentDefinition)
              .withConfig({
                ownerScope: { kind: "org", orgId: "org_123" },
                sandboxProviders: { [CLOUDFLARE_SANDBOX_PROVIDER]: provider },
              })
              .withServices({ workflows: harness.fragment.services }),
          })) satisfies NonNullable<
            WorkflowScenarioHarnessOptions<
              ReturnType<typeof createLifecycleWorkflows>
            >["configureFragments"]
          >,
          fragmentConfig: {
            onWorkflowTerminal: async (payload) => {
              if (payload.workflowName !== "sandbox-lifecycle") {
                return;
              }
              await automationFragment!.callServices(() =>
                automationFragment!.services.stopSandboxInstanceForTerminalWorkflow({
                  workflowInstanceId: payload.instanceId,
                }),
              );
            },
          },
        },
        steps: ({ workflow, runner }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              const requested = await automationFragment.callServices(() =>
                automationFragment!.services.requestSandboxInstance(params),
              );
              workflowInstanceId = requested.workflowInstanceId ?? "";
            },
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: workflowInstanceId,
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) => ctx.harness.terminateInstance("SANDBOX_LIFECYCLE", workflowInstanceId),
          }),
          runner.drainHooks(),
          workflow.read({
            read: (ctx) => readSandboxInstance(ctx.harness.db, params.id),
            assert: (row) => {
              expect(row).toMatchObject({ status: "stopped" });
            },
          }),
          workflow.read({
            read: async () => {
              await automationFragment!.callServices(() =>
                automationFragment!.services.stopSandboxInstanceForTerminalWorkflow({
                  workflowInstanceId,
                }),
              );
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  test("terminal workflow hooks preserve sandbox error records after runtime reconciliation", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::terminal-error" });
    const workflowInstanceId = "sandbox-terminal-error-1";
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-terminal-error-preserve-status",
        workflows,
        harness: {
          ...automationScenarioHarness,
          configureFragments: ((harness) => ({
            automations: instantiate(automationFragmentDefinition)
              .withConfig({
                ownerScope: { kind: "org", orgId: "org_123" },
                sandboxProviders: { [CLOUDFLARE_SANDBOX_PROVIDER]: provider },
              })
              .withServices({ workflows: harness.fragment.services }),
          })) satisfies NonNullable<
            WorkflowScenarioHarnessOptions<
              ReturnType<typeof createLifecycleWorkflows>
            >["configureFragments"]
          >,
        },
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, workflowInstanceId);
              await automationFragment.callServices(() =>
                automationFragment!.services.markSandboxInstanceError({
                  id: params.id,
                  lastError: "startup failed",
                }),
              );
            },
          }),
          workflow.read({
            read: async () => {
              await automationFragment!.callServices(() =>
                automationFragment!.services.stopSandboxInstanceForTerminalWorkflow({
                  workflowInstanceId,
                }),
              );
            },
          }),
          workflow.read({
            read: (ctx) => readSandboxInstance(ctx.harness.db, params.id),
            assert: (row) => {
              expect(row).toMatchObject({ status: "error", lastError: "startup failed" });
              expect(row?.stoppedAt).toBeTruthy();
            },
          }),
        ],
      }),
    );

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  test("stop requests clear terminal errored sandbox lifecycle records", async () => {
    const handle = createRuntimeHandle({
      exec: vi.fn(async () => ({ success: false, stdout: "", stderr: "boom", exitCode: 1 })),
    });
    const provider = createProvider(handle);
    const params = defaultParams({ id: "org_123::errored-stop-request" });
    let automationFragment: AutomationFragment | undefined;
    let workflowInstanceId = "";
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-terminal-error-stop-request",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              const requested = await automationFragment.callServices(() =>
                automationFragment!.services.requestSandboxInstance(params),
              );
              workflowInstanceId = requested.workflowInstanceId ?? "";
            },
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: workflowInstanceId,
                reason: "create",
              }),
          }),
          workflow.read({
            read: async (ctx) => {
              for (let attempt = 0; attempt < 10; attempt += 1) {
                ctx.clock.advanceBy("24 hours");
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: workflowInstanceId,
                  reason: "retry",
                });
              }
            },
          }),
          workflow.read({
            read: async () => {
              await expect(
                automationFragment!.callServices(() =>
                  automationFragment!.services.requestSandboxInstanceStop({
                    id: params.id,
                    workflowInstanceId,
                  }),
                ),
              ).resolves.toMatchObject({ status: "stopped" });
            },
          }),
          workflow.read({
            read: (ctx) => readSandboxInstance(ctx.harness.db, params.id),
            assert: (row) => {
              expect(row).toMatchObject({ status: "stopped" });
            },
          }),
        ],
      }),
    );
  });

  test("default startup command and timeout execute true with the default timeout", async () => {
    const handle = createRuntimeHandle();
    const provider = createProvider(handle);
    const params = {
      id: "org_123::startup-defaults",
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      sleepAfter: "10s",
    } satisfies SandboxLifecycleWorkflowParams;
    let automationFragment: AutomationFragment | undefined;
    const workflows = createLifecycleWorkflows({
      provider,
      getAutomationFragment: () => automationFragment,
    });

    await runScenario(
      defineScenario({
        name: "sandbox-lifecycle-startup-defaults",
        workflows,
        harness: automationScenarioHarness,
        steps: ({ workflow }) => [
          workflow.read({
            read: async (ctx) => {
              automationFragment = ctx.harness.fragments.automations.fragment as AutomationFragment;
              await seedSandboxInstance(ctx, params, "sandbox-startup-defaults-1");
            },
          }),
          workflow.create({
            workflow: "SANDBOX_LIFECYCLE",
            id: "sandbox-startup-defaults-1",
            params,
          }),
          workflow.read({
            read: (ctx) =>
              ctx.harness.runUntilIdle({
                workflowName: "sandbox-lifecycle",
                instanceId: "sandbox-startup-defaults-1",
                reason: "create",
              }),
          }),
          workflow.read({
            read: (ctx) =>
              (async () => {
                await ctx.harness.sendEvent("sandbox-lifecycle", "sandbox-startup-defaults-1", {
                  type: "sandbox.stopRequested",
                  payload: { sandboxId: params.id },
                });
                await ctx.harness.runUntilIdle({
                  workflowName: "sandbox-lifecycle",
                  instanceId: "sandbox-startup-defaults-1",
                  reason: "event",
                });
              })(),
          }),
        ],
      }),
    );

    expect(handle.exec).toHaveBeenCalledWith("true", { timeout: 15_000 });
  });
});
