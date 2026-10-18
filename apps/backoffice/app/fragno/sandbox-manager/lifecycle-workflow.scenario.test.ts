import { assert, expect, test } from "vitest";

import type {
  SandboxContainerControl,
  SandboxExecOutcome,
  SandboxStartRequest,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";
import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";

import { instantiate } from "@fragno-dev/core";
import { drainDurableHooks } from "@fragno-dev/test";

import type { SandboxRuntimeProvider } from "@/sandbox/contracts";
import { SandboxRuntimeError } from "@/sandbox/sandbox-runtime-error";

import {
  CLOUDFLARE_SANDBOX_PROVIDER,
  type SandboxInstanceRecord,
  type SandboxInstanceStatus,
  type SandboxLifecycleEvent,
} from "./contracts";
import { sandboxManagerFragmentDefinition } from "./definition";
import { defineSandboxLifecycleWorkflow } from "./lifecycle-workflow";
import type { createSandboxManagerFragment } from "./sandbox-manager-fragment";
import { SANDBOX_LIFECYCLE_WORKFLOW_NAME } from "./services";

type SandboxManagerFragment = ReturnType<typeof createSandboxManagerFragment>;

type SandboxLifecycleScenarioVars = {
  requested?: SandboxInstanceRecord;
  resumed?: SandboxInstanceRecord;
  retryAt?: Date;
};

type ScenarioSandboxOperation =
  | {
      operation: "start";
      request: SandboxStartRequest;
      persistedStatus: SandboxInstanceStatus | null;
    }
  | { operation: "exec"; command: string; timeoutMs: number }
  | { operation: "snapshot"; snapshotId: string | null }
  | { operation: "stop" };

/** One sandbox container whose snapshots are numbered in the order they are taken. */
class ScenarioSandboxProvider implements SandboxRuntimeProvider {
  readonly provider = CLOUDFLARE_SANDBOX_PROVIDER;
  readonly operations: ScenarioSandboxOperation[] = [];
  #running = false;
  #snapshotCount = 0;
  readonly #readPersistedStatus: (sandboxId: string) => Promise<SandboxInstanceStatus | null>;
  readonly #execOutcomes: SandboxExecOutcome[];

  constructor(
    readPersistedStatus: (sandboxId: string) => Promise<SandboxInstanceStatus | null>,
    execOutcomes: SandboxExecOutcome[] = [],
  ) {
    this.#readPersistedStatus = readPersistedStatus;
    this.#execOutcomes = execOutcomes;
  }

  async getHandle(id: string): Promise<SandboxContainerControl> {
    return {
      start: async (request) => {
        this.operations.push({
          operation: "start",
          request,
          persistedStatus: await this.#readPersistedStatus(id),
        });
        this.#running = true;
        return {
          restoredSnapshot:
            request.source.kind === "snapshot"
              ? { id: request.source.snapshotId, restoredAt: new Date().toISOString() }
              : null,
        };
      },
      exec: async ({ argv, timeoutMs }) => {
        this.operations.push({ operation: "exec", command: argv.at(-1) ?? "", timeoutMs });
        return (
          this.#execOutcomes.shift() ?? { status: "exited", exitCode: 0, stdout: "", stderr: "" }
        );
      },
      snapshot: async () => {
        if (!this.#running) {
          this.operations.push({ operation: "snapshot", snapshotId: null });
          return { status: "not_running" };
        }
        this.#snapshotCount += 1;
        const snapshotId = `snapshot-${this.#snapshotCount}`;
        this.operations.push({ operation: "snapshot", snapshotId });
        return { status: "saved", snapshot: { id: snapshotId, size: 1024 } };
      },
      stop: async () => {
        this.operations.push({ operation: "stop" });
        this.#running = false;
      },
    };
  }
}

class PermanentFailureSandboxRuntimeProvider implements SandboxRuntimeProvider {
  readonly provider = CLOUDFLARE_SANDBOX_PROVIDER;
  handleAttempts = 0;

  async getHandle(): Promise<SandboxContainerControl> {
    this.handleAttempts += 1;
    throw new SandboxRuntimeError({
      code: "unauthorized",
      reason: "authentication_failed",
      retryable: false,
      message: "Sandbox bridge authentication failed.",
    });
  }
}

function createSandboxLifecycleScenarioConfig(
  createProvider: (
    readPersistedStatus: (sandboxId: string) => Promise<SandboxInstanceStatus | null>,
  ) => SandboxRuntimeProvider,
) {
  const lifecycleEvents: SandboxLifecycleEvent[] = [];
  let sandboxManagerFragment: SandboxManagerFragment | undefined;

  function requireSandboxManagerFragment() {
    if (!sandboxManagerFragment) {
      throw new Error("Sandbox lifecycle scenario fragment is not initialized.");
    }
    return sandboxManagerFragment;
  }

  const provider = createProvider(async (id) => {
    const fragment = requireSandboxManagerFragment();
    const instance = await fragment.callServices(() =>
      fragment.services.getSandboxInstance({ id }),
    );
    return instance?.status ?? null;
  });
  const sandboxManagerConfig = {
    sandboxProviders: { [CLOUDFLARE_SANDBOX_PROVIDER]: provider },
    deliverLifecycleEvent: async (event: SandboxLifecycleEvent) => {
      lifecycleEvents.push(event);
    },
  };
  const workflows = {
    SANDBOX_LIFECYCLE: defineSandboxLifecycleWorkflow({
      sandboxProviders: sandboxManagerConfig.sandboxProviders,
      getSandboxManagerFragment: () => sandboxManagerFragment,
    }),
  } as const;

  return {
    lifecycleEvents,
    workflows,
    sandboxManagerConfig,
    requireSandboxManagerFragment,
    async onWorkflowTerminal(payload: { workflowName: string; instanceId: string }) {
      if (payload.workflowName !== SANDBOX_LIFECYCLE_WORKFLOW_NAME) {
        return;
      }
      const fragment = requireSandboxManagerFragment();
      await fragment.callServices(() =>
        fragment.services.stopSandboxInstanceForTerminalWorkflow({
          workflowInstanceId: payload.instanceId,
        }),
      );
    },
    bindFragment(fragment: SandboxManagerFragment) {
      sandboxManagerFragment = fragment;
    },
  };
}

test("stopping a sandbox saves its workspace and starting it again restores that workspace", async () => {
  const sandboxId = "org_123::scenario";
  let provider: ScenarioSandboxProvider | undefined;
  const scenario = createSandboxLifecycleScenarioConfig((readPersistedStatus) => {
    provider = new ScenarioSandboxProvider(readPersistedStatus, [
      { status: "timed_out", stdout: "", stderr: "" },
    ]);
    return provider;
  });
  assert(provider);
  const sandboxProvider = provider;

  await runScenario(
    defineScenario({
      name: "sandbox-manager-lifecycle",
      workflows: scenario.workflows,
      vars: (): SandboxLifecycleScenarioVars => ({}),
      harness: {
        fragmentConfig: { onWorkflowTerminal: scenario.onWorkflowTerminal },
        configureFragments: (harness) => ({
          sandboxManager: instantiate(sandboxManagerFragmentDefinition)
            .withConfig(scenario.sandboxManagerConfig)
            .withRoutes([])
            .withServices({ workflows: harness.fragment.services }),
        }),
      },
      steps: ({ workflow, hooks }) => {
        const drain = () =>
          workflow.read({
            read: async (ctx) => {
              await drainDurableHooks(
                Object.values(ctx.harness.fragments).map((result) => result.fragment),
              );
            },
          });
        const run = (key: "requested" | "resumed", reason: "create" | "event" | "retry") =>
          workflow.read({
            read: async (ctx) => {
              const instanceId = ctx.vars[key]?.workflowInstanceId;
              assert(instanceId);
              return await ctx.harness.runUntilIdle({
                workflowName: SANDBOX_LIFECYCLE_WORKFLOW_NAME,
                instanceId,
                reason,
              });
            },
            assert: (result) => {
              expect(result.processed).toBeGreaterThan(0);
            },
          });
        const requestStop = (key: "requested" | "resumed") =>
          workflow.read({
            read: async (ctx) => {
              const workflowInstanceId = ctx.vars[key]?.workflowInstanceId;
              assert(workflowInstanceId);
              const fragment = scenario.requireSandboxManagerFragment();
              return await fragment.callServices(() =>
                fragment.services.requestSandboxInstanceStop({ id: sandboxId, workflowInstanceId }),
              );
            },
            assert: (instance) => {
              expect(instance).toMatchObject({ id: sandboxId, status: "stopping" });
            },
          });
        const readInstance = (assertInstance: (instance: SandboxInstanceRecord | null) => void) =>
          workflow.read({
            read: async () => {
              const fragment = scenario.requireSandboxManagerFragment();
              return await fragment.callServices(() =>
                fragment.services.getSandboxInstance({ id: sandboxId }),
              );
            },
            assert: assertInstance,
          });

        return [
          workflow.read({
            read: async (ctx) => {
              const fragment = ctx.harness.fragments.sandboxManager.fragment;
              scenario.bindFragment(fragment);
              return await fragment.callServices(() =>
                fragment.services.requestSandboxInstance({
                  id: sandboxId,
                  provider: CLOUDFLARE_SANDBOX_PROVIDER,
                  keepAlive: true,
                  startupCommand: "scenario-start",
                  startupTimeoutMs: 2_500,
                  instanceType: "standard-1",
                }),
              );
            },
            storeAs: "requested",
          }),
          workflow.assert((ctx) => {
            expect(ctx.vars.requested).toMatchObject({
              id: sandboxId,
              status: "requested",
              keepAlive: true,
              startupCommand: "scenario-start",
              startupTimeoutMs: 2_500,
              image: "workspace",
              instanceType: "standard-1",
              workspaceSnapshot: null,
            });
          }),
          drain(),
          hooks.read({
            fragment: "sandboxManager",
            hookName: "enqueueSandboxLifecycleWorkflow",
            assert: (hookRows) => {
              expect(hookRows).toEqual([expect.objectContaining({ status: "completed" })]);
            },
          }),
          run("requested", "create"),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.requested?.workflowInstanceId);
              const steps = await ctx.state.getSteps(
                "SANDBOX_LIFECYCLE",
                ctx.vars.requested.workflowInstanceId,
              );
              return steps.find((step) => step.stepKey === "do:run sandbox startup command")
                ?.nextRetryAt;
            },
            storeAs: "retryAt",
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.retryAt);
              ctx.clock.set(new Date(ctx.vars.retryAt.getTime() + 1));
            },
          }),
          run("requested", "retry"),
          readInstance((instance) => {
            expect(instance).toMatchObject({ id: sandboxId, status: "running", lastError: null });
          }),
          drain(),
          requestStop("requested"),
          run("requested", "event"),
          drain(),
          readInstance((instance) => {
            expect(instance).toMatchObject({
              id: sandboxId,
              status: "stopped",
              lastError: null,
              workspaceSnapshot: { id: "snapshot-1", size: 1024, expiresAt: expect.any(String) },
            });
            expect(instance?.stoppedAt).toBeInstanceOf(Date);
          }),
          workflow.read({
            read: async (ctx) => {
              assert(ctx.vars.requested?.workflowInstanceId);
              return await ctx.state.getStatus(
                "SANDBOX_LIFECYCLE",
                ctx.vars.requested.workflowInstanceId,
              );
            },
            assert: (status) => {
              expect(status).toMatchObject({
                status: "complete",
                output: { sandboxId, stopReason: "stop request" },
              });
            },
          }),

          // Without an image or instance type, the next start resumes the saved workspace as-is.
          workflow.read({
            read: async () => {
              const fragment = scenario.requireSandboxManagerFragment();
              return await fragment.callServices(() =>
                fragment.services.requestSandboxInstance({
                  id: sandboxId,
                  provider: CLOUDFLARE_SANDBOX_PROVIDER,
                  keepAlive: true,
                }),
              );
            },
            storeAs: "resumed",
          }),
          drain(),
          run("resumed", "create"),
          readInstance((instance) => {
            expect(instance).toMatchObject({
              id: sandboxId,
              status: "running",
              image: "workspace",
              instanceType: "standard-1",
            });
          }),
          drain(),
          requestStop("resumed"),
          run("resumed", "event"),
          drain(),
          readInstance((instance) => {
            expect(instance).toMatchObject({
              status: "stopped",
              workspaceSnapshot: { id: "snapshot-2" },
            });
          }),
          workflow.assert((ctx) => {
            const requestedId = ctx.vars.requested?.workflowInstanceId;
            const resumedId = ctx.vars.resumed?.workflowInstanceId;
            assert(requestedId && resumedId);
            const freshStart = {
              operation: "start",
              request: {
                source: { kind: "image", image: "workspace" },
                instanceType: "standard-1",
                leaseExpiresAt: null,
              },
              persistedStatus: "starting",
            };
            expect(sandboxProvider.operations).toEqual([
              freshStart,
              { operation: "exec", command: "scenario-start", timeoutMs: 2_500 },
              { operation: "exec", command: "scenario-start", timeoutMs: 2_500 },
              { operation: "snapshot", snapshotId: "snapshot-1" },
              { operation: "stop" },
              {
                operation: "start",
                request: {
                  source: { kind: "snapshot", snapshotId: "snapshot-1" },
                  instanceType: "standard-1",
                  leaseExpiresAt: null,
                },
                persistedStatus: "starting",
              },
              { operation: "exec", command: "true", timeoutMs: 15_000 },
              { operation: "snapshot", snapshotId: "snapshot-2" },
              { operation: "stop" },
            ]);
            expect(scenario.lifecycleEvents.map((event) => event.id)).toEqual([
              `${requestedId}:ready`,
              `${requestedId}:stopped`,
              `${resumedId}:ready`,
              `${resumedId}:stopped`,
            ]);
          }),
        ];
      },
    }),
  );
});

test("a saved workspace keeps its image until its snapshot expires", async () => {
  const sandboxId = "org_123::pinned";
  let provider: ScenarioSandboxProvider | undefined;
  const scenario = createSandboxLifecycleScenarioConfig((readPersistedStatus) => {
    provider = new ScenarioSandboxProvider(readPersistedStatus);
    return provider;
  });
  assert(provider);
  const sandboxProvider = provider;

  await runScenario(
    defineScenario({
      name: "sandbox-manager-workspace-image",
      workflows: scenario.workflows,
      vars: (): SandboxLifecycleScenarioVars => ({}),
      harness: {
        fragmentConfig: { onWorkflowTerminal: scenario.onWorkflowTerminal },
        configureFragments: (harness) => ({
          sandboxManager: instantiate(sandboxManagerFragmentDefinition)
            .withConfig(scenario.sandboxManagerConfig)
            .withRoutes([])
            .withServices({ workflows: harness.fragment.services }),
        }),
      },
      steps: ({ workflow }) => [
        workflow.read({
          read: async (ctx) => {
            const fragment = ctx.harness.fragments.sandboxManager.fragment;
            scenario.bindFragment(fragment);
            const instance = await fragment.callServices(() =>
              fragment.services.requestSandboxInstance({
                id: sandboxId,
                provider: CLOUDFLARE_SANDBOX_PROVIDER,
                keepAlive: true,
                image: "debian",
              }),
            );
            const workflowInstanceId = instance.workflowInstanceId;
            assert(workflowInstanceId);
            // A stopped sandbox whose last stop saved its workspace.
            await fragment.callServices(() => [
              fragment.services.markSandboxInstanceStopped({ id: sandboxId, workflowInstanceId }),
              fragment.services.recordSandboxWorkspaceSnapshot({
                id: sandboxId,
                workspaceSnapshot: {
                  id: "snapshot-debian",
                  size: 2048,
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              }),
            ]);
            return instance;
          },
          storeAs: "requested",
        }),
        workflow.read({
          read: async () => {
            const fragment = scenario.requireSandboxManagerFragment();
            return await fragment
              .callServices(() =>
                fragment.services.requestSandboxInstance({
                  id: sandboxId,
                  provider: CLOUDFLARE_SANDBOX_PROVIDER,
                  image: "workspace",
                }),
              )
              .then(
                () => null,
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              );
          },
          assert: (message) => {
            expect(message).toContain('has a saved workspace on the "debian" image');
          },
        }),
        workflow.read({
          read: async () => {
            const fragment = scenario.requireSandboxManagerFragment();
            await fragment.callServices(() =>
              fragment.services.recordSandboxWorkspaceSnapshot({
                id: sandboxId,
                workspaceSnapshot: {
                  id: "snapshot-debian",
                  size: 2048,
                  expiresAt: new Date(Date.now() - 60_000).toISOString(),
                },
              }),
            );
            return await fragment.callServices(() =>
              fragment.services.requestSandboxInstance({
                id: sandboxId,
                provider: CLOUDFLARE_SANDBOX_PROVIDER,
                keepAlive: true,
                image: "workspace",
              }),
            );
          },
          storeAs: "resumed",
        }),
        workflow.read({
          read: async (ctx) => {
            await drainDurableHooks(
              Object.values(ctx.harness.fragments).map((result) => result.fragment),
            );
            const instanceId = ctx.vars.resumed?.workflowInstanceId;
            assert(instanceId);
            await ctx.harness.runUntilIdle({
              workflowName: SANDBOX_LIFECYCLE_WORKFLOW_NAME,
              instanceId,
              reason: "create",
            });
          },
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.resumed).toMatchObject({
            status: "requested",
            image: "workspace",
            workspaceSnapshot: null,
          });
          expect(sandboxProvider.operations[0]).toMatchObject({
            operation: "start",
            request: { source: { kind: "image", image: "workspace" } },
          });
        }),
      ],
    }),
  );
});

test("does not retry permanent sandbox provider startup failures", async () => {
  const sandboxId = "org_123::permanent-failure";
  let provider: PermanentFailureSandboxRuntimeProvider | undefined;
  const scenario = createSandboxLifecycleScenarioConfig(() => {
    provider = new PermanentFailureSandboxRuntimeProvider();
    return provider;
  });
  assert(provider);
  const failingProvider = provider;

  await runScenario(
    defineScenario({
      name: "sandbox-manager-permanent-startup-failure",
      workflows: scenario.workflows,
      vars: (): { requested?: SandboxInstanceRecord } => ({}),
      harness: {
        configureFragments: (harness) => ({
          sandboxManager: instantiate(sandboxManagerFragmentDefinition)
            .withConfig(scenario.sandboxManagerConfig)
            .withRoutes([])
            .withServices({ workflows: harness.fragment.services }),
        }),
      },
      steps: ({ workflow }) => [
        workflow.read({
          read: async (ctx) => {
            const fragment = ctx.harness.fragments.sandboxManager.fragment;
            scenario.bindFragment(fragment);
            return await fragment.callServices(() =>
              fragment.services.requestSandboxInstance({
                id: sandboxId,
                provider: CLOUDFLARE_SANDBOX_PROVIDER,
                keepAlive: true,
              }),
            );
          },
          storeAs: "requested",
        }),
        workflow.read({
          read: async (ctx) => {
            await drainDurableHooks(
              Object.values(ctx.harness.fragments).map((result) => result.fragment),
            );
          },
        }),
        workflow.read({
          read: async (ctx) => {
            assert(ctx.vars.requested?.workflowInstanceId);
            return await ctx.harness.runUntilIdle({
              workflowName: SANDBOX_LIFECYCLE_WORKFLOW_NAME,
              instanceId: ctx.vars.requested.workflowInstanceId,
              reason: "create",
            });
          },
        }),
        workflow.read({
          read: async (ctx) => {
            assert(ctx.vars.requested?.workflowInstanceId);
            const fragment = scenario.requireSandboxManagerFragment();
            const [instance, workflowStatus] = await Promise.all([
              fragment.callServices(() => fragment.services.getSandboxInstance({ id: sandboxId })),
              ctx.state.getStatus("SANDBOX_LIFECYCLE", ctx.vars.requested.workflowInstanceId),
            ]);
            return { instance, workflowStatus };
          },
          assert: ({ instance, workflowStatus }) => {
            expect(instance).toMatchObject({
              id: sandboxId,
              status: "error",
              lastError:
                "Sandbox startup failed after retries. Cause: [unauthorized] Sandbox bridge authentication failed.",
            });
            expect(workflowStatus).toMatchObject({
              status: "errored",
              error: {
                name: "NonRetryableError",
                message: "[unauthorized] Sandbox bridge authentication failed.",
              },
            });
            assert(failingProvider.handleAttempts === 1);
          },
        }),
      ],
    }),
  );
});
