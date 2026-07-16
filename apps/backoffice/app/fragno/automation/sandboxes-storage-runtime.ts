import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { SandboxRuntimeProvider } from "@/sandbox/contracts";

import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "./contracts";
import type { AutomationWorkflowsService } from "./definition";
import type { AutomationHookServiceContext, AutomationHookUnitOfWork } from "./internal-hooks";
import { reconcileSandboxStopped } from "./sandbox-lifecycle-workflow";
import {
  sandboxInstanceListInputSchema,
  sandboxInstanceLookupInputSchema,
  sandboxInstanceMarkErrorInputSchema,
  sandboxInstanceMarkRunningInputSchema,
  sandboxInstanceMarkStartingInputSchema,
  sandboxInstanceMarkStoppedInputSchema,
  sandboxInstanceMarkStoppingInputSchema,
  sandboxInstanceRequestInputSchema,
  sandboxInstanceSchema,
  sandboxInstanceStopRequestInputSchema,
  sandboxInstanceWorkflowLookupInputSchema,
  CLOUDFLARE_SANDBOX_PROVIDER,
  type SandboxInstanceListInput,
  type SandboxInstanceLookupInput,
  type SandboxInstanceRecord,
  type SandboxInstanceWorkflowLookupInput,
  type SandboxInstanceMarkErrorInput,
  type SandboxInstanceMarkRunningInput,
  type SandboxInstanceMarkStartingInput,
  type SandboxInstanceMarkStoppedInput,
  type SandboxInstanceMarkStoppingInput,
  type SandboxInstanceRequestInput,
  type SandboxInstanceStopRequestInput,
} from "./sandboxes";
import { automationFragmentSchema } from "./schema";
import { automationTimestampToIsoString } from "./timestamps";

export const SANDBOX_LIFECYCLE_WORKFLOW_NAME = "sandbox-lifecycle" as const;

export type SandboxLifecycleWorkflowParams = SandboxInstanceRequestInput;

type AutomationSandboxServicesOptions = {
  workflows: AutomationWorkflowsService;
  ownerScope: BackofficeContextScope;
  sandboxProviders?: Record<string, SandboxRuntimeProvider>;
  ingestEvent: (uow: AutomationHookUnitOfWork, event: AutomationEvent) => void;
};

const ACTIVE_SANDBOX_INSTANCE_STATUSES = new Set(["requested", "starting", "running", "stopping"]);
const TERMINAL_WORKFLOW_STATUSES = new Set(["complete", "errored", "terminated"]);

const sleepAfterMs = (sleepAfter: string | number) => {
  if (typeof sleepAfter === "number") {
    return sleepAfter * 1000;
  }

  const match = sleepAfter.match(/^(\d+)([smh])$/iu);
  if (!match) {
    throw new Error("Invalid sandbox sleepAfter value.");
  }

  const amount = Number(match[1]);
  switch (match[2]?.toLowerCase()) {
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    default:
      throw new Error("Invalid sandbox sleepAfter value.");
  }
};

const sandboxScopeSubject = (scope: BackofficeContextScope, sandboxId: string) => ({
  ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
  ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
  sandboxId,
});

const sandboxPayload = (
  sandbox: Pick<SandboxInstanceRecord, "id" | "provider" | "status">,
  details: { reason?: string; errorMessage?: string } = {},
) => ({
  sandboxId: sandbox.id,
  provider: sandbox.provider,
  status: sandbox.status,
  ...(details.reason ? { reason: details.reason } : {}),
  ...(details.errorMessage ? { error: { message: details.errorMessage } } : {}),
});

export const createAutomationSandboxServices = (
  defineService: <TService>(service: TService & ThisType<AutomationHookServiceContext>) => TService,
  options: AutomationSandboxServicesOptions,
) =>
  defineService({
    listSandboxInstances(args?: SandboxInstanceListInput) {
      const input = sandboxInstanceListInputSchema.parse(args) ?? {};
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("sandbox_instance", (b) => {
            const query = input.provider
              ? b.whereIndex("idx_sandbox_instance_provider", (eb) =>
                  eb("provider", "=", input.provider!),
                )
              : b.whereIndex("primary");
            return input.limit ? query.pageSize(input.limit) : query;
          }),
        )
        .transformRetrieve(([instances]) =>
          instances.map((instance) => sandboxInstanceSchema.parse(instance)),
        )
        .build();
    },

    getSandboxInstance(args: SandboxInstanceLookupInput) {
      const input = sandboxInstanceLookupInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
          ),
        )
        .transformRetrieve(([instance]) =>
          instance ? sandboxInstanceSchema.parse(instance) : null,
        )
        .build();
    },

    stopSandboxInstanceForTerminalWorkflow(args: SandboxInstanceWorkflowLookupInput) {
      const input = sandboxInstanceWorkflowLookupInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b.whereIndex("idx_sandbox_instance_workflowInstanceId", (eb) =>
              eb("workflowInstanceId", "=", input.workflowInstanceId),
            ),
          ),
        )
        .transformRetrieve(async ([instance]) => {
          if (!instance || instance.status === "stopped") {
            return { instance, shouldRecordReconciliation: false };
          }

          const provider = options.sandboxProviders?.[instance.provider];
          if (!provider) {
            throw new Error(`No sandbox provider configured for '${instance.provider}'.`);
          }

          await reconcileSandboxStopped(provider, String(instance.id));
          return { instance, shouldRecordReconciliation: true };
        })
        .mutate(({ uow, retrieveResult: { instance, shouldRecordReconciliation } }) => {
          if (!instance) {
            return null;
          }
          if (!shouldRecordReconciliation) {
            return instance;
          }

          const now = uow.now();
          const next = {
            ...instance,
            status: instance.status === "error" ? instance.status : ("stopped" as const),
            stoppedAt: now,
            updatedAt: now,
          };
          uow.update("sandbox_instance", instance.id, (b) =>
            b.set({ status: next.status, stoppedAt: next.stoppedAt, updatedAt: now }).check(),
          );
          const sandbox = {
            id: String(instance.id),
            provider: CLOUDFLARE_SANDBOX_PROVIDER,
            status: "stopped",
          } as const;
          const event: AutomationEvent = {
            id: crypto.randomUUID(),
            scope: options.ownerScope,
            source: "sandbox",
            eventType: "instance.stopped",
            occurredAt: automationTimestampToIsoString(now),
            payload: sandboxPayload(sandbox, { reason: "workflow_terminal" }),
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: sandboxScopeSubject(options.ownerScope, sandbox.id),
          };
          options.ingestEvent(uow, event);
          return next;
        })
        .transform(({ mutateResult }) =>
          mutateResult ? sandboxInstanceSchema.parse(mutateResult) : null,
        )
        .build();
    },

    requestSandboxInstance(args: SandboxInstanceRequestInput) {
      const input = sandboxInstanceRequestInputSchema.parse(args);
      const workflows = options.workflows;
      const workflowParams = {
        ...input,
        keepAlive: input.keepAlive ?? false,
        startupCommand: input.startupCommand || "true",
        startupTimeoutMs: input.startupTimeoutMs ?? 15_000,
      } satisfies SandboxLifecycleWorkflowParams;

      return this.serviceTx(automationFragmentSchema)
        .withServiceCalls(
          () =>
            [
              workflows.createInstance(SANDBOX_LIFECYCLE_WORKFLOW_NAME, {
                params: workflowParams,
              }),
            ] as const,
        )
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing], serviceIntermediateResult: [workflow] }) => {
          if (existing && ACTIVE_SANDBOX_INSTANCE_STATUSES.has(existing.status)) {
            return existing;
          }

          const workflowInstanceId = (workflow as { id: string }).id;
          const now = uow.now();
          const next = {
            id: input.id,
            provider: input.provider,
            status: "requested" as const,
            workflowInstanceId,
            keepAlive: input.keepAlive ?? false,
            sleepAfter: input.sleepAfter ?? null,
            startupCommand: input.startupCommand || "true",
            startupTimeoutMs: input.startupTimeoutMs ?? 15_000,
            startedAt: null,
            expectedStopAt: null,
            stoppedAt: null,
            lastError: null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };

          if (existing) {
            uow.update("sandbox_instance", existing.id, (b) =>
              b
                .set({
                  provider: next.provider,
                  status: next.status,
                  workflowInstanceId: next.workflowInstanceId,
                  keepAlive: next.keepAlive,
                  sleepAfter: next.sleepAfter,
                  startupCommand: next.startupCommand,
                  startupTimeoutMs: next.startupTimeoutMs,
                  startedAt: null,
                  expectedStopAt: null,
                  stoppedAt: null,
                  lastError: null,
                  updatedAt: now,
                })
                .check(),
            );
            return { ...existing, ...next };
          }

          uow.create("sandbox_instance", next);
          return next;
        })
        .transform(({ mutateResult }) => sandboxInstanceSchema.parse(mutateResult))
        .build();
    },

    requestSandboxInstanceStop(args: SandboxInstanceStopRequestInput) {
      const input = sandboxInstanceStopRequestInputSchema.parse(args);
      const workflows = options.workflows;
      const stopRequestedEvent = {
        type: "sandbox.stopRequested",
        payload: { sandboxId: input.id },
        ignoreTerminal: true,
      } satisfies Parameters<AutomationWorkflowsService["sendEvent"]>[2] & {
        ignoreTerminal: true;
      };

      return this.serviceTx(automationFragmentSchema)
        .withServiceCalls(
          () =>
            [
              workflows.sendEvent(
                SANDBOX_LIFECYCLE_WORKFLOW_NAME,
                input.workflowInstanceId,
                stopRequestedEvent,
              ),
            ] as const,
        )
        .retrieve((uow) =>
          uow.findFirst("sandbox_instance", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing], serviceIntermediateResult: [workflow] }) => {
          if (!existing) {
            return null;
          }

          const [workflowInstance] = workflow;
          const now = uow.now();
          const isTerminalWorkflow = workflowInstance
            ? TERMINAL_WORKFLOW_STATUSES.has(workflowInstance.status)
            : false;
          const next = {
            ...existing,
            status: isTerminalWorkflow ? ("stopped" as const) : ("stopping" as const),
            stoppedAt: isTerminalWorkflow ? now : existing.stoppedAt,
            updatedAt: now,
          };
          uow.update("sandbox_instance", existing.id, (b) =>
            b.set({ status: next.status, stoppedAt: next.stoppedAt, updatedAt: now }).check(),
          );
          if (isTerminalWorkflow) {
            const sandbox = {
              id: String(existing.id),
              provider: CLOUDFLARE_SANDBOX_PROVIDER,
              status: next.status,
            } as const;
            const event: AutomationEvent = {
              id: crypto.randomUUID(),
              scope: options.ownerScope,
              source: "sandbox",
              eventType: "instance.stopped",
              occurredAt: automationTimestampToIsoString(now),
              payload: sandboxPayload(sandbox, { reason: "stop_requested" }),
              actor: AUTOMATION_SYSTEM_ACTOR,
              actors: [AUTOMATION_SYSTEM_ACTOR],
              subject: sandboxScopeSubject(options.ownerScope, sandbox.id),
            };
            options.ingestEvent(uow, event);
          }
          return next;
        })
        .transform(({ mutateResult }) =>
          mutateResult ? sandboxInstanceSchema.parse(mutateResult) : null,
        )
        .build();
    },

    markSandboxInstanceStarting(args: SandboxInstanceMarkStartingInput) {
      const input = sandboxInstanceMarkStartingInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({ status: "starting", updatedAt: uow.now() }),
          );
        })
        .build();
    },

    markSandboxInstanceRunning(args: SandboxInstanceMarkRunningInput) {
      const input = sandboxInstanceMarkRunningInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          const sleepAfter = input.sleepAfter ?? null;
          const expectedStopAt =
            input.keepAlive || sleepAfter === null ? null : now.plus(sleepAfterMs(sleepAfter));
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({
              status: "running",
              startedAt: now,
              expectedStopAt,
              lastError: null,
              updatedAt: now,
            }),
          );
          const sandbox = {
            id: input.id,
            provider: input.provider ?? CLOUDFLARE_SANDBOX_PROVIDER,
            status: "running",
          } as const;
          const event: AutomationEvent = {
            id: crypto.randomUUID(),
            scope: options.ownerScope,
            source: "sandbox",
            eventType: "instance.ready",
            occurredAt: automationTimestampToIsoString(now),
            payload: sandboxPayload(sandbox),
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: sandboxScopeSubject(options.ownerScope, sandbox.id),
          };
          options.ingestEvent(uow, event);
        })
        .build();
    },

    markSandboxInstanceStopping(args: SandboxInstanceMarkStoppingInput) {
      const input = sandboxInstanceMarkStoppingInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({ status: "stopping", updatedAt: now }),
          );
        })
        .build();
    },

    markSandboxInstanceStopped(args: SandboxInstanceMarkStoppedInput) {
      const input = sandboxInstanceMarkStoppedInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({
              status: "stopped",
              stoppedAt: now,
              updatedAt: now,
            }),
          );
          const sandbox = {
            id: input.id,
            provider: input.provider ?? CLOUDFLARE_SANDBOX_PROVIDER,
            status: "stopped",
          } as const;
          const event: AutomationEvent = {
            id: crypto.randomUUID(),
            scope: options.ownerScope,
            source: "sandbox",
            eventType: "instance.stopped",
            occurredAt: automationTimestampToIsoString(now),
            payload: sandboxPayload(sandbox),
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: sandboxScopeSubject(options.ownerScope, sandbox.id),
          };
          options.ingestEvent(uow, event);
        })
        .build();
    },

    markSandboxInstanceError(args: SandboxInstanceMarkErrorInput) {
      const input = sandboxInstanceMarkErrorInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.update("sandbox_instance", input.id, (b) =>
            b.set({
              status: "error",
              lastError: input.lastError,
              updatedAt: now,
            }),
          );
          const sandbox = {
            id: input.id,
            provider: input.provider ?? CLOUDFLARE_SANDBOX_PROVIDER,
            status: "error",
          } as const;
          const event: AutomationEvent = {
            id: crypto.randomUUID(),
            scope: options.ownerScope,
            source: "sandbox",
            eventType: "instance.failed",
            occurredAt: automationTimestampToIsoString(now),
            payload: sandboxPayload(sandbox, { reason: "error", errorMessage: input.lastError }),
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: sandboxScopeSubject(options.ownerScope, sandbox.id),
          };
          options.ingestEvent(uow, event);
        })
        .build();
    },
  });
