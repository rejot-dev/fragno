import { assert, expect, test } from "vitest";

import { defineScenario, runScenario } from "@fragno-dev/workflows/scenario";

import { instantiate } from "@fragno-dev/core";
import { drainDurableHooks } from "@fragno-dev/test";

import type {
  SandboxCommandResult,
  SandboxRuntimeExecOptions,
  SandboxRuntimeExecResult,
  SandboxRuntimeHandle,
  SandboxRuntimeHandleOptions,
  SandboxRuntimeProvider,
} from "@/sandbox/contracts";
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
  retryAt?: Date;
  startRun?: { processed: number; ticks: number };
};

type SandboxHandleObservation = {
  operation: "start" | "reconcile";
  persistedStatus: SandboxInstanceStatus | null;
  keepAlive: boolean | null;
  sleepAfter: string | number | null;
};

class ScenarioSandboxRuntimeHandle implements SandboxRuntimeHandle {
  readonly id: string;
  readonly #executeStartupCommand: (
    command: string,
    options: SandboxRuntimeExecOptions,
  ) => SandboxRuntimeExecResult;
  readonly #recordDestroy: () => void;

  constructor(
    id: string,
    executeStartupCommand: (
      command: string,
      options: SandboxRuntimeExecOptions,
    ) => SandboxRuntimeExecResult,
    recordDestroy: () => void,
  ) {
    this.id = id;
    this.#executeStartupCommand = executeStartupCommand;
    this.#recordDestroy = recordDestroy;
  }

  async exec(
    command: string,
    options: SandboxRuntimeExecOptions = {},
  ): Promise<SandboxRuntimeExecResult> {
    return this.#executeStartupCommand(command, options);
  }

  async destroy(): Promise<void> {
    this.#recordDestroy();
  }

  async executeCommand(): Promise<SandboxCommandResult> {
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }

  async mountBucket(): Promise<void> {}

  async mkdir(): Promise<void> {}

  async writeFile(): Promise<void> {}

  async exists(): Promise<{ exists: boolean }> {
    return { exists: false };
  }
}

class ScenarioSandboxRuntimeProvider implements SandboxRuntimeProvider {
  readonly provider = CLOUDFLARE_SANDBOX_PROVIDER;
  readonly handleObservations: SandboxHandleObservation[] = [];
  readonly startupCommands: Array<{ command: string; timeout: number | null }> = [];
  destroyCount = 0;
  readonly #handles = new Map<string, ScenarioSandboxRuntimeHandle>();
  readonly #readPersistedStatus: (sandboxId: string) => Promise<SandboxInstanceStatus | null>;
  readonly #startupResults: SandboxRuntimeExecResult[];

  constructor(
    readPersistedStatus: (sandboxId: string) => Promise<SandboxInstanceStatus | null>,
    startupResults: SandboxRuntimeExecResult[] = [],
  ) {
    this.#readPersistedStatus = readPersistedStatus;
    this.#startupResults = startupResults;
  }

  async getHandle(
    id: string,
    options: SandboxRuntimeHandleOptions = {},
  ): Promise<SandboxRuntimeHandle> {
    const existing = this.#handles.get(id);
    this.handleObservations.push({
      operation: existing ? "reconcile" : "start",
      persistedStatus: await this.#readPersistedStatus(id),
      keepAlive: options.keepAlive ?? null,
      sleepAfter: options.sleepAfter ?? null,
    });
    if (existing) {
      return existing;
    }

    const handle = new ScenarioSandboxRuntimeHandle(
      id,
      (command, execOptions) => {
        this.startupCommands.push({ command, timeout: execOptions.timeout ?? null });
        return (
          this.#startupResults.shift() ?? {
            success: true,
            stdout: "",
            stderr: "",
            exitCode: 0,
          }
        );
      },
      () => {
        this.destroyCount += 1;
      },
    );
    this.#handles.set(id, handle);
    return handle;
  }
}

class PermanentFailureSandboxRuntimeProvider implements SandboxRuntimeProvider {
  readonly provider = CLOUDFLARE_SANDBOX_PROVIDER;
  handleAttempts = 0;

  async getHandle(): Promise<SandboxRuntimeHandle> {
    this.handleAttempts += 1;
    throw new SandboxRuntimeError({
      code: "unauthorized",
      reason: "authentication_failed",
      retryable: false,
      message: "Sandbox bridge authentication failed.",
    });
  }
}

test("runs the sandbox lifecycle workflow through provider cleanup and lifecycle delivery", async () => {
  const sandboxId = "org_123::scenario";
  const lifecycleEvents: SandboxLifecycleEvent[] = [];
  let sandboxManagerFragment: SandboxManagerFragment | undefined;

  function requireSandboxManagerFragment() {
    if (!sandboxManagerFragment) {
      throw new Error("Sandbox lifecycle scenario fragment is not initialized.");
    }
    return sandboxManagerFragment;
  }

  const provider = new ScenarioSandboxRuntimeProvider(
    async (id) => {
      const fragment = requireSandboxManagerFragment();
      const instance = await fragment.callServices(() =>
        fragment.services.getSandboxInstance({ id }),
      );
      return instance?.status ?? null;
    },
    [
      { success: false, stdout: "", stderr: "Killed", exitCode: 137 },
      { success: true, stdout: "", stderr: "", exitCode: 0 },
    ],
  );
  const sandboxManagerConfig = {
    sandboxProviders: { [CLOUDFLARE_SANDBOX_PROVIDER]: provider },
    deliverLifecycleEvent: async (event: SandboxLifecycleEvent) => {
      lifecycleEvents.push(event);
    },
  };
  const sandboxLifecycleWorkflow = defineSandboxLifecycleWorkflow({
    sandboxProviders: sandboxManagerConfig.sandboxProviders,
    getSandboxManagerFragment: () => sandboxManagerFragment,
  });
  const workflows = { SANDBOX_LIFECYCLE: sandboxLifecycleWorkflow } as const;

  await runScenario(
    defineScenario({
      name: "sandbox-manager-lifecycle",
      workflows,
      vars: (): SandboxLifecycleScenarioVars => ({}),
      harness: {
        fragmentConfig: {
          onWorkflowTerminal: async function reconcileTerminalSandboxLifecycle(payload) {
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
        },
        configureFragments: (harness) => ({
          sandboxManager: instantiate(sandboxManagerFragmentDefinition)
            .withConfig(sandboxManagerConfig)
            .withRoutes([])
            .withServices({ workflows: harness.fragment.services }),
        }),
      },
      steps: ({ workflow, hooks }) => [
        workflow.read({
          read: async (ctx) => {
            const fragment = ctx.harness.fragments.sandboxManager.fragment;
            sandboxManagerFragment = fragment;
            return await fragment.callServices(() =>
              fragment.services.requestSandboxInstance({
                id: sandboxId,
                provider: CLOUDFLARE_SANDBOX_PROVIDER,
                keepAlive: true,
                startupCommand: "scenario-start",
                startupTimeoutMs: 2_500,
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
          });
        }),
        workflow.read({
          read: async (ctx) => {
            await drainDurableHooks(
              Object.values(ctx.harness.fragments).map((result) => result.fragment),
            );
          },
        }),
        hooks.read({
          fragment: "sandboxManager",
          hookName: "enqueueSandboxLifecycleWorkflow",
          assert: (hookRows) => {
            expect(hookRows).toEqual([expect.objectContaining({ status: "completed" })]);
          },
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
            expect(status).toMatchObject({ status: "active" });
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
          storeAs: "startRun",
        }),
        workflow.assert((ctx) => {
          expect(ctx.vars.startRun).toMatchObject({ processed: expect.any(Number) });
          expect(ctx.vars.startRun?.processed).toBeGreaterThan(0);
        }),
        workflow.read({
          read: async (ctx) => {
            assert(ctx.vars.requested?.workflowInstanceId);
            const steps = await ctx.state.getSteps(
              "SANDBOX_LIFECYCLE",
              ctx.vars.requested.workflowInstanceId,
            );
            return steps.find((step) => step.stepKey === "do:start sandbox runtime")?.nextRetryAt;
          },
          storeAs: "retryAt",
        }),
        workflow.read({
          read: async (ctx) => {
            assert(ctx.vars.requested?.workflowInstanceId);
            assert(ctx.vars.retryAt);
            ctx.clock.set(new Date(ctx.vars.retryAt.getTime() + 1));
            return await ctx.harness.runUntilIdle({
              workflowName: SANDBOX_LIFECYCLE_WORKFLOW_NAME,
              instanceId: ctx.vars.requested.workflowInstanceId,
              reason: "retry",
            });
          },
          assert: (run) => {
            expect(run.processed).toBeGreaterThan(0);
          },
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
            expect(status).toMatchObject({ status: "waiting" });
          },
        }),
        workflow.read({
          read: async () => {
            const fragment = requireSandboxManagerFragment();
            return await fragment.callServices(() =>
              fragment.services.getSandboxInstance({ id: sandboxId }),
            );
          },
          assert: (instance) => {
            expect(instance).toMatchObject({
              id: sandboxId,
              status: "running",
              lastError: null,
            });
          },
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
            const workflowInstanceId = ctx.vars.requested?.workflowInstanceId;
            assert(workflowInstanceId);
            const fragment = requireSandboxManagerFragment();
            return await fragment.callServices(() =>
              fragment.services.requestSandboxInstanceStop({
                id: sandboxId,
                workflowInstanceId,
              }),
            );
          },
          assert: (instance) => {
            expect(instance).toMatchObject({ id: sandboxId, status: "stopping" });
          },
        }),
        workflow.read({
          read: async (ctx) => {
            assert(ctx.vars.requested?.workflowInstanceId);
            return await ctx.harness.runUntilIdle({
              workflowName: SANDBOX_LIFECYCLE_WORKFLOW_NAME,
              instanceId: ctx.vars.requested.workflowInstanceId,
              reason: "event",
            });
          },
          assert: (run) => {
            expect(run.processed).toBeGreaterThan(0);
          },
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
            const fragment = requireSandboxManagerFragment();
            const instance = await fragment.callServices(() =>
              fragment.services.getSandboxInstance({ id: sandboxId }),
            );
            const workflowStatus = await ctx.state.getStatus(
              "SANDBOX_LIFECYCLE",
              ctx.vars.requested.workflowInstanceId,
            );
            return { instance, workflowStatus };
          },
          assert: ({ instance, workflowStatus }) => {
            expect(instance).toMatchObject({
              id: sandboxId,
              status: "stopped",
              lastError: null,
            });
            expect(instance?.stoppedAt).toBeInstanceOf(Date);
            expect(workflowStatus).toMatchObject({
              status: "complete",
              output: { sandboxId, stopReason: "stop request" },
            });
          },
        }),
        workflow.assert((ctx) => {
          assert(ctx.vars.requested?.workflowInstanceId);
          expect(provider.handleObservations).toEqual([
            {
              operation: "start",
              persistedStatus: "starting",
              keepAlive: true,
              sleepAfter: null,
            },
            {
              operation: "reconcile",
              persistedStatus: "starting",
              keepAlive: true,
              sleepAfter: null,
            },
            {
              operation: "reconcile",
              persistedStatus: "stopping",
              keepAlive: null,
              sleepAfter: null,
            },
          ]);
          expect(provider.startupCommands).toEqual([
            { command: "scenario-start", timeout: 2_500 },
            { command: "scenario-start", timeout: 2_500 },
          ]);
          assert(provider.destroyCount === 1);
          expect(lifecycleEvents).toEqual([
            {
              id: `${ctx.vars.requested.workflowInstanceId}:ready`,
              type: "ready",
              sandboxId,
              provider: CLOUDFLARE_SANDBOX_PROVIDER,
              status: "running",
            },
            {
              id: `${ctx.vars.requested.workflowInstanceId}:stopped`,
              type: "stopped",
              sandboxId,
              provider: CLOUDFLARE_SANDBOX_PROVIDER,
              status: "stopped",
            },
          ]);
        }),
      ],
    }),
  );
});

test("does not retry permanent sandbox provider startup failures", async () => {
  const sandboxId = "org_123::permanent-failure";
  const provider = new PermanentFailureSandboxRuntimeProvider();
  let sandboxManagerFragment: SandboxManagerFragment | undefined;

  function requireSandboxManagerFragment() {
    if (!sandboxManagerFragment) {
      throw new Error("Permanent failure scenario fragment is not initialized.");
    }
    return sandboxManagerFragment;
  }

  const sandboxManagerConfig = {
    sandboxProviders: { [CLOUDFLARE_SANDBOX_PROVIDER]: provider },
    deliverLifecycleEvent: async () => undefined,
  };
  const sandboxLifecycleWorkflow = defineSandboxLifecycleWorkflow({
    sandboxProviders: sandboxManagerConfig.sandboxProviders,
    getSandboxManagerFragment: () => sandboxManagerFragment,
  });

  await runScenario(
    defineScenario({
      name: "sandbox-manager-permanent-startup-failure",
      workflows: { SANDBOX_LIFECYCLE: sandboxLifecycleWorkflow },
      vars: (): { requested?: SandboxInstanceRecord } => ({}),
      harness: {
        configureFragments: (harness) => ({
          sandboxManager: instantiate(sandboxManagerFragmentDefinition)
            .withConfig(sandboxManagerConfig)
            .withRoutes([])
            .withServices({ workflows: harness.fragment.services }),
        }),
      },
      steps: ({ workflow }) => [
        workflow.read({
          read: async (ctx) => {
            sandboxManagerFragment = ctx.harness.fragments.sandboxManager.fragment;
            const fragment = requireSandboxManagerFragment();
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
            const fragment = requireSandboxManagerFragment();
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
              lastError: "Sandbox startup failed after retries.",
            });
            expect(workflowStatus).toMatchObject({
              status: "errored",
              error: {
                name: "NonRetryableError",
                message: "[unauthorized] Sandbox bridge authentication failed.",
              },
            });
            assert(provider.handleAttempts === 1);
          },
        }),
      ],
    }),
  );
});
