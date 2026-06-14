import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import type { AutomationEventActor } from "@/fragno/automation/contracts";
import { createRouteBackedDurableHooksRuntime } from "@/fragno/automation/durable-hooks-route-runtime";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import { createMcpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import { createOtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import { createPiRouteRuntime, type PiRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import { createResendRouteRuntime } from "@/fragno/runtime-tools/families/resend-runtime";
import { createReson8RouteRuntime } from "@/fragno/runtime-tools/families/reson8-runtime";
import { createSandboxRouteRuntime } from "@/fragno/runtime-tools/families/sandbox-route-runtime";
import { createTelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";

import type { InteractiveBashCommandContext } from "./bash-host";
import { getRuntimeToolNamespacesByCapability, runtimeToolFamilies } from "./tool-families";

const normalizeOrgId = (orgId: string | undefined) => orgId?.trim() || undefined;

export type RouteBackedRuntimeContextOptions = {
  runtime: BackofficeRuntimeServices;
  orgId: string;
  pi?: { runtime: PiRuntime } | null;
  defaultActor?: AutomationEventActor | null;
};

/**
 * Creates the standard org-scoped runtime context.
 *
 * This is intentionally the shared baseline for interactive bash, Pi codemode,
 * and automation execution. Event-scoped execution should start from this
 * context and only add `automation` / `event` on top.
 */
export const createRouteBackedRuntimeContext = ({
  runtime,
  orgId,
  pi,
  defaultActor,
}: RouteBackedRuntimeContextOptions): InteractiveBashCommandContext => {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (!normalizedOrgId) {
    throw new Error("Route-backed runtime context requires an organisation id");
  }

  return {
    ...(typeof defaultActor === "undefined" ? {} : { defaultActor }),
    backoffice: {
      runtime: createBackofficeCapabilitiesRuntime({
        objects: runtime.objects,
        config: runtime.config,
        orgId: normalizedOrgId,
        runtimeToolNamespacesByCapability: getRuntimeToolNamespacesByCapability(),
      }),
    },
    automation: null,
    automations: {
      runtime: createRouteBackedAutomationStoreRuntime({
        objects: runtime.objects,
        orgId: normalizedOrgId,
      }),
    },
    workflow: {
      runtime: createRouteBackedAutomationWorkflowRuntime({
        objects: runtime.objects,
        orgId: normalizedOrgId,
      }),
    },
    durableHooks: {
      runtime: createRouteBackedDurableHooksRuntime({
        objects: runtime.objects,
        config: runtime.config,
        orgId: normalizedOrgId,
      }),
    },
    internal: {
      runtime: createInternalRuntime({
        objects: runtime.objects,
        config: runtime.config,
        orgId: normalizedOrgId,
        families: runtimeToolFamilies,
      }),
    },
    mcp: runtime.config.bindings.mcp
      ? {
          runtime: createMcpRuntime({ objects: runtime.objects, orgId: normalizedOrgId }),
        }
      : null,
    otp: {
      runtime: createOtpRuntime({
        objects: runtime.objects,
        config: runtime.config,
        orgId: normalizedOrgId,
      }),
    },
    pi: pi ?? {
      runtime: createPiRouteRuntime({ objects: runtime.objects, orgId: normalizedOrgId }),
    },
    reson8: {
      runtime: createReson8RouteRuntime({ objects: runtime.objects, orgId: normalizedOrgId }),
    },
    resend: {
      runtime: createResendRouteRuntime({ objects: runtime.objects, orgId: normalizedOrgId }),
    },
    sandbox:
      runtime.config.bindings.sandbox && runtime.config.bindings.sandboxRegistry
        ? {
            runtime: createSandboxRouteRuntime({
              objects: runtime.objects,
              orgId: normalizedOrgId,
            }),
          }
        : null,
    telegram: {
      runtime: createTelegramRuntime({ objects: runtime.objects, orgId: normalizedOrgId }),
    },
  };
};
