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
  env: CloudflareEnv;
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
  env,
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
        env,
        orgId: normalizedOrgId,
        runtimeToolNamespacesByCapability: getRuntimeToolNamespacesByCapability(),
      }),
    },
    automation: null,
    automations: {
      runtime: createRouteBackedAutomationStoreRuntime({ env, orgId: normalizedOrgId }),
    },
    workflow: {
      runtime: createRouteBackedAutomationWorkflowRuntime({ env, orgId: normalizedOrgId }),
    },
    durableHooks: {
      runtime: createRouteBackedDurableHooksRuntime({ env, orgId: normalizedOrgId }),
    },
    internal: {
      runtime: createInternalRuntime({
        env,
        orgId: normalizedOrgId,
        families: runtimeToolFamilies,
      }),
    },
    mcp: env.MCP
      ? {
          runtime: createMcpRuntime({ env, orgId: normalizedOrgId }),
        }
      : null,
    otp: {
      runtime: createOtpRuntime({ env, orgId: normalizedOrgId }),
    },
    pi: pi ?? {
      runtime: createPiRouteRuntime({ env, orgId: normalizedOrgId }),
    },
    reson8: {
      runtime: createReson8RouteRuntime({ env, orgId: normalizedOrgId }),
    },
    resend: {
      runtime: createResendRouteRuntime({ env, orgId: normalizedOrgId }),
    },
    sandbox:
      env.SANDBOX && env.SANDBOX_REGISTRY
        ? {
            runtime: createSandboxRouteRuntime({ env, orgId: normalizedOrgId }),
          }
        : null,
    telegram: {
      runtime: createTelegramRuntime({ env, orgId: normalizedOrgId }),
    },
  };
};
