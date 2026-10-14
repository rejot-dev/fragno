import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { Context } from "@earendil-works/chord";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { codemodeRunnerFor, type CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import {
  createPiManagerRuntime,
  type PiManagerRuntime,
} from "@/fragno/pi/manager/pi-manager-runtime";
import type {
  InteractiveRuntimeToolContext,
  RegisteredAutomationsRuntime,
} from "@/fragno/runtime-tools/bash-host";
import type { OtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import type { ResendRuntime } from "@/fragno/runtime-tools/families/resend";
import type { TelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

/** Runtime services available to Backoffice tools executed by a durable Pi agent. */
export type PiRuntimeToolContext = InteractiveRuntimeToolContext & {
  automations: { runtime: RegisteredAutomationsRuntime };
  otp: { runtime: OtpRuntime };
  pi: { runtime: PiManagerRuntime };
  resend: { runtime: ResendRuntime };
  telegram: { runtime: TelegramRuntime };
};

/** Backoffice authority and services that one agent's extensions run with. */
export type BackofficeAgentContext = {
  sessionId: string;
  billingOrganizationId: string | null;
  execution: BackofficeExecutionContext;
  /** Null when the runtime has no Worker Loader; codemode-backed extensions fail closed. */
  codemode: CodemodeRunner | null;
  /** Checks live permissions; persisted actors carry identity, not grants. */
  authorize: () => Promise<void>;
  toolContext: (invocationId: string, context: Context) => PiRuntimeToolContext;
};

/** Returns the scoped filesystem used by durable Pi tools and prompt sections. */
export function requirePiStateBackend(context: PiRuntimeToolContext): BackofficeStateBackend {
  if (!context.stateBackend) {
    throw new Error("Pi requires a state backend.");
  }
  return context.stateBackend;
}

/** Rebuilds the scoped Backoffice context from persisted provenance after every agent restart. */
export function createBackofficeAgentContext(input: {
  config: PiAgentConfig;
  runtime: BackofficeRuntimeServices;
}): BackofficeAgentContext {
  const { config, runtime } = input;
  const kernel = new BackofficeKernel(runtime);
  const execution: BackofficeExecutionContext = {
    kind: "deferred",
    scope: config.scope,
    scopeRestriction: config.scopeRestriction,
    actors: config.actors,
  };

  async function authorize() {
    if (config.scope.kind === "user" && config.billingOrganizationId === null) {
      throw new Error(
        "PI_BILLING_OWNER_REQUIRED: user-scoped Pi sessions require a billing organization.",
      );
    }
    await kernel.assertAuthorized({
      execution,
      operation: BACKOFFICE_PERMISSION.pi.modify,
      resource: { kind: "pi-agent-execution", sessionId: config.sessionId },
    });
    if (
      config.billingOrganizationId !== null &&
      (config.scope.kind === "user" || config.scope.kind === "system")
    ) {
      await kernel.assertAuthorized({
        execution: { ...execution, scope: { kind: "org", orgId: config.billingOrganizationId } },
        operation: BACKOFFICE_PERMISSION.pi.modify,
        resource: { kind: "pi-agent-billing", sessionId: config.sessionId },
      });
    }
  }

  function toolContext(invocationId: string, context: Context): PiRuntimeToolContext {
    let promptIndex = 0;
    const createPromptRequestId = () => `${invocationId}:${promptIndex++}`;
    return createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution,
      billingOrganizationId: config.billingOrganizationId,
      // A factory follows scope changes; a fixed runtime would leak the parent directory into child contexts.
      pi: (scopedExecution) => ({
        runtime: createPiManagerRuntime({
          runtime,
          kernel,
          execution: scopedExecution,
          defaultBillingOrganizationId: config.billingOrganizationId,
          createPromptRequestId,
          context,
        }),
      }),
    }) as PiRuntimeToolContext;
  }

  return {
    sessionId: config.sessionId,
    billingOrganizationId: config.billingOrganizationId,
    execution,
    codemode: runtime.codemodeEnv
      ? codemodeRunnerFor(
          kernel.scoped("CODEMODE", config.scope, runtime.objects.codemode).commands,
          execution,
        )
      : null,
    authorize,
    toolContext,
  };
}
