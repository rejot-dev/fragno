import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeUnavailableError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { IFileSystem } from "@/files/interface";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import type { AutomationEventActor } from "@/fragno/automation/contracts";
import { createRouteBackedDurableHooksRuntime } from "@/fragno/automation/durable-hooks-route-runtime";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import {
  createApiRuntime,
  createUnavailableApiRuntime,
} from "@/fragno/runtime-tools/families/api-runtime";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import {
  createMcpRuntime,
  createUnavailableMcpRuntime,
} from "@/fragno/runtime-tools/families/mcp-runtime";
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
  fileSystem?: IFileSystem;
};

const unavailableMessage = (family: string, execution: BackofficeExecutionContext) =>
  `${family} is not available in ${execution.scope.kind} context.`;

const unavailableRuntime = <T>(message: string): T =>
  new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error(message);
      },
    },
  ) as T;

export const createRouteBackedRuntimeContext = ({
  runtime,
  kernel,
  execution,
  pi,
  defaultActor,
  fileSystem,
}: RouteBackedRuntimeContextOptions): InteractiveBashCommandContext => {
  kernel.assertContextAccess(execution);
  if (execution.scope.kind === "project") {
    throw new BackofficeUnavailableError("Project context is not available.");
  }
  const org = execution.scope.kind === "org" ? { orgId: execution.scope.orgId } : null;
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
        fileSystem,
      }),
    backoffice: org
      ? {
          runtime: createBackofficeCapabilitiesRuntime({
            objects: runtime.objects,
            config: runtime.config,
            orgId: org.orgId,
            runtimeToolNamespacesByCapability: getRuntimeToolNamespacesByCapability(),
          }),
        }
      : null,
    automation: null,
    automations: {
      runtime: createRouteBackedAutomationStoreRuntime({
        object: automationsObject,
        ...(org ? { orgId: org.orgId } : {}),
      }),
    },
    workflow: {
      runtime: createRouteBackedAutomationWorkflowRuntime({
        object: automationsObject,
        ...(org ? { orgId: org.orgId } : {}),
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
            fileSystem,
          }),
        }
      : null,
    api: runtime.config.bindings.api
      ? {
          runtime:
            execution.scope.kind === "org" || execution.scope.kind === "user"
              ? createApiRuntime(kernel.scoped("API", execution.scope, runtime.objects.api))
              : createUnavailableApiRuntime(unavailableMessage("API", execution)),
        }
      : null,
    mcp: runtime.config.bindings.mcp
      ? {
          runtime:
            execution.scope.kind === "org" || execution.scope.kind === "user"
              ? createMcpRuntime(kernel.scoped("MCP", execution.scope, runtime.objects.mcp))
              : createUnavailableMcpRuntime(unavailableMessage("MCP", execution)),
        }
      : null,
    otp: {
      runtime: org
        ? createOtpRuntime({
            object: kernel.scoped("OTP", execution.scope, runtime.objects.otp),
            config: runtime.config,
            orgId: org.orgId,
          })
        : createUnavailableOtpRuntime(unavailableMessage("OTP", execution)),
    },
    pi: pi ?? {
      runtime: org
        ? createPiRouteRuntime({
            object: kernel.scoped("PI", execution.scope, runtime.objects.pi),
            orgId: org.orgId,
          })
        : createUnavailablePiRuntime(unavailableMessage("PI", execution)),
    },
    reson8: {
      runtime: org
        ? createReson8RouteRuntime({
            object: kernel.scoped("RESON8", execution.scope, runtime.objects.reson8),
          })
        : createUnavailableReson8Runtime(unavailableMessage("RESON8", execution)),
    },
    resend: {
      runtime: org
        ? createResendRouteRuntime({
            object: kernel.scoped("RESEND", execution.scope, runtime.objects.resend),
          })
        : createUnavailableResendRuntime(unavailableMessage("RESEND", execution)),
    },
    sandbox:
      runtime.config.bindings.sandbox && runtime.config.bindings.sandboxRegistry
        ? {
            runtime: org
              ? createSandboxRouteRuntime({
                  objects: runtime.objects,
                  orgId: org.orgId,
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
