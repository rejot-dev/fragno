import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeUnavailableError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import type { AutomationEventActor } from "@/fragno/automation/contracts";
import { createRouteBackedDurableHooksRuntime } from "@/fragno/automation/durable-hooks-route-runtime";
import { createRouteBackedAutomationRouterRuntime } from "@/fragno/automation/routing-route-runtime";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { createApiRuntime } from "@/fragno/runtime-tools/families/api-runtime";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import { createMcpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import {
  createOtpRuntime,
  createUnavailableOtpRuntime,
} from "@/fragno/runtime-tools/families/otp-runtime";
import {
  createPiRouteRuntime,
  createUnavailablePiRuntime,
  type PiRuntime,
} from "@/fragno/runtime-tools/families/pi-runtime";
import {
  createResendRouteRuntime,
  createUnavailableResendRuntime,
} from "@/fragno/runtime-tools/families/resend-runtime";
import {
  createReson8RouteRuntime,
  createUnavailableReson8Runtime,
} from "@/fragno/runtime-tools/families/reson8-runtime";
import { createSandboxRouteRuntime } from "@/fragno/runtime-tools/families/sandbox-route-runtime";
import {
  createTelegramRuntime,
  createUnavailableTelegramRuntime,
} from "@/fragno/runtime-tools/families/telegram-runtime";

import type { InteractiveBashCommandContext } from "./bash-host";
import { getRuntimeToolNamespacesByCapability, runtimeToolFamilies } from "./tool-families";

export type RouteBackedRuntimeContextOptions = {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  pi?: { runtime: PiRuntime } | null;
  defaultActor?: AutomationEventActor | null;
};

const unavailableMessage = (family: string, execution: BackofficeExecutionContext) =>
  `${family} is not available in ${execution.scope.kind} context.`;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- The caller supplies the unavailable runtime interface represented by this throwing proxy.
const unavailableRuntime = <T>(message: string): T =>
  new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error(message);
      },
    },
  ) as T;

const ownerOrgScope = (execution: BackofficeExecutionContext): { orgId: string } | null =>
  execution.scope.kind === "org" || execution.scope.kind === "project"
    ? { orgId: execution.scope.orgId }
    : null;

const selectedOrgScope = (execution: BackofficeExecutionContext): { orgId: string } | null =>
  execution.scope.kind === "org" ? { orgId: execution.scope.orgId } : null;

const unavailableObject = <T>(resolve: () => T): T | null => {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof BackofficeUnavailableError) {
      return null;
    }
    throw error;
  }
};

export const createRouteBackedRuntimeContext = ({
  runtime,
  kernel,
  execution,
  pi,
  defaultActor,
}: RouteBackedRuntimeContextOptions): InteractiveBashCommandContext => {
  kernel.assertContextAccess(execution);
  const org = ownerOrgScope(execution);
  const selectedOrg = selectedOrgScope(execution);
  const automationsObject = kernel.scoped(
    "AUTOMATIONS",
    execution.scope,
    runtime.objects.automations,
  );

  return {
    defaultActor: defaultActor ?? null,
    backofficeExecution: execution,
    backofficeKernel: kernel,
    createBackofficeScopedContext: (scope) =>
      createRouteBackedRuntimeContext({
        runtime,
        kernel,
        execution: { actor: execution.actor, scope },
        defaultActor,
      }),
    backoffice: isBackofficeRoutableScope(execution.scope)
      ? {
          runtime: createBackofficeCapabilitiesRuntime({
            objects: runtime.objects,
            config: runtime.config,
            scope: execution.scope,
            runtimeToolNamespacesByCapability: getRuntimeToolNamespacesByCapability(),
          }),
        }
      : null,
    automation: null,
    event: {
      runtime: createEventRuntime({
        objects: runtime.objects,
        kernel,
        execution,
      }),
    },
    automations: {
      runtime: {
        ...createRouteBackedAutomationStoreRuntime({
          object: automationsObject,
          scope: execution.scope,
        }),
        ...createRouteBackedAutomationRouterRuntime({
          object: automationsObject,
          scope: execution.scope,
        }),
      },
    },
    workflow: {
      runtime: createRouteBackedAutomationWorkflowRuntime({
        object: automationsObject,
        scope: execution.scope,
      }),
    },
    durableHooks: org
      ? {
          runtime: createRouteBackedDurableHooksRuntime({
            objects: runtime.objects,
            config: runtime.config,
            orgId: org.orgId,
          }),
        }
      : null,
    internal: org
      ? {
          runtime: createInternalRuntime({
            objects: runtime.objects,
            config: runtime.config,
            orgId: org.orgId,
            families: runtimeToolFamilies,
          }),
        }
      : null,
    api: runtime.config.bindings.api
      ? (() => {
          const object = unavailableObject(() =>
            kernel.scoped("API", execution.scope, runtime.objects.api),
          );
          return object ? { runtime: createApiRuntime(object) } : null;
        })()
      : null,
    mcp: runtime.config.bindings.mcp
      ? (() => {
          const object = unavailableObject(() =>
            kernel.scoped("MCP", execution.scope, runtime.objects.mcp),
          );
          return object ? { runtime: createMcpRuntime(object) } : null;
        })()
      : null,
    otp: {
      runtime: selectedOrg
        ? createOtpRuntime({
            object: kernel.scoped("OTP", execution.scope, runtime.objects.otp),
            config: runtime.config,
            orgId: selectedOrg.orgId,
          })
        : createUnavailableOtpRuntime(unavailableMessage("OTP", execution)),
    },
    pi: pi ?? {
      runtime: selectedOrg
        ? createPiRouteRuntime({
            object: kernel.scoped("PI", execution.scope, runtime.objects.pi),
            orgId: selectedOrg.orgId,
          })
        : createUnavailablePiRuntime(unavailableMessage("PI", execution)),
    },
    reson8: {
      runtime: selectedOrg
        ? createReson8RouteRuntime({
            object: kernel.scoped("RESON8", execution.scope, runtime.objects.reson8),
          })
        : createUnavailableReson8Runtime(unavailableMessage("RESON8", execution)),
    },
    resend: {
      runtime: selectedOrg
        ? createResendRouteRuntime({
            object: kernel.scoped("RESEND", execution.scope, runtime.objects.resend),
          })
        : createUnavailableResendRuntime(unavailableMessage("RESEND", execution)),
    },
    sandbox:
      runtime.config.bindings.sandbox && runtime.config.bindings.automations
        ? {
            runtime: selectedOrg
              ? createSandboxRouteRuntime({
                  objects: runtime.objects,
                  orgId: selectedOrg.orgId,
                })
              : unavailableRuntime(unavailableMessage("SANDBOX", execution)),
          }
        : null,
    telegram:
      execution.scope.kind === "org"
        ? {
            runtime: createTelegramRuntime({
              object: kernel.scoped("TELEGRAM", execution.scope, runtime.objects.telegram),
            }),
          }
        : {
            runtime: createUnavailableTelegramRuntime(
              `TELEGRAM is not available in ${execution.scope.kind} context.`,
            ),
          },
  };
};
