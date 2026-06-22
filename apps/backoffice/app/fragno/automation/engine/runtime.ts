import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeForbiddenError, BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BashHostContext } from "@/fragno/runtime-tools/bash-host";
import type { PiRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import { createUnavailableResendRuntime } from "@/fragno/runtime-tools/families/resend-runtime";
import { createUnavailableReson8Runtime } from "@/fragno/runtime-tools/families/reson8-runtime";
import { createUnavailableTelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import type {
  AutomationCommandContext,
  AutomationTriggerBinding,
} from "../../runtime-tools/automation-types";
import type { AutomationStoreRuntime } from "../../runtime-tools/families/automations-bindings";
import type {} from "../../runtime-tools/families/event";
import {
  createUnavailableEventRuntime,
  createEventRuntime,
  type EventRuntime,
} from "../../runtime-tools/families/event-runtime";
import type {} from "../../runtime-tools/families/otp";
import { type OtpRuntime } from "../../runtime-tools/families/otp-runtime";
import type { AutomationEvent } from "../contracts";

export type AutomationPiBashContext = {
  runtime: PiRuntime;
};

export type AutomationRuntime = AutomationStoreRuntime & OtpRuntime & EventRuntime;

export type AutomationRuntimeCommandContext = AutomationCommandContext & {
  runtime: AutomationRuntime;
};

export type AutomationRuntimeHostContext = Omit<
  BashHostContext,
  "automation" | "automations" | "otp"
> & {
  automation: AutomationRuntimeCommandContext;
  automations: {
    runtime: AutomationStoreRuntime;
  };
  otp: {
    runtime: OtpRuntime;
  };
};

export const createAutomationRuntime = ({
  runtime,
  event,
}: {
  runtime?: BackofficeRuntimeServices;
  event: AutomationEvent;
}): AutomationRuntime => {
  const requireRouteBackend = (toolName: string) => {
    if (!runtime) {
      throw new Error(`${toolName} is not configured`);
    }
    throw new Error(`${toolName} is not available in ${event.scope.kind} automation scope`);
  };

  if (runtime) {
    const kernel = new BackofficeKernel({ objects: runtime.objects });
    const execution: BackofficeExecutionContext = {
      actor: {
        type: "automation",
        id: `automation:${event.id}`,
        ...(event.scope.kind === "org" || event.scope.kind === "project"
          ? { organizationIds: [event.scope.orgId] }
          : {}),
      },
      scope: event.scope,
    };
    const routeBacked = createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution,
    });
    return {
      ...routeBacked.automations.runtime,
      ...routeBacked.otp.runtime,
      ...createEventRuntime({
        objects: runtime.objects,
        event,
        kernel,
        execution,
      }),
    };
  }

  return {
    get: async () => requireRouteBackend("store.get"),
    set: async () => requireRouteBackend("store.set"),
    delete: async () => requireRouteBackend("store.delete"),
    list: async () => requireRouteBackend("store.list"),
    createClaim: async () => requireRouteBackend("otp.identity.create-claim"),
    ...createUnavailableEventRuntime(),
  };
};

export const createAutomationExecutionContext = ({
  event,
  binding,
  idempotencyKey,
  runtime,
  runtimeServices,
  pi,
}: {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  runtime: AutomationRuntime;
  runtimeServices?: BackofficeRuntimeServices;
  pi: AutomationPiBashContext | null;
}): AutomationRuntimeHostContext => {
  const execution: BackofficeExecutionContext = {
    actor: {
      type: "automation",
      id: `automation:${event.id}`,
      ...(event.scope.kind === "org" || event.scope.kind === "project"
        ? { organizationIds: [event.scope.orgId] }
        : {}),
    },
    scope: event.scope,
  };

  const routeBacked = runtimeServices
    ? createRouteBackedRuntimeContext({
        runtime: runtimeServices,
        kernel: new BackofficeKernel({ objects: runtimeServices.objects }),
        execution,
        ...(pi ? { pi: { runtime: pi.runtime } } : {}),
      })
    : null;

  return {
    ...(routeBacked ?? {
      defaultActor: null,
      backofficeExecution: execution,
      backofficeKernel: new BackofficeKernel({}),
      createBackofficeScopedContext: () => {
        throw new BackofficeForbiddenError("Backoffice runtime services are not configured.");
      },
      backoffice: null,
      workflow: null,
      durableHooks: null,
      mcp: null,
      pi: null,
      reson8: { runtime: createUnavailableReson8Runtime() },
      resend: { runtime: createUnavailableResendRuntime() },
      sandbox: null,
      telegram: { runtime: createUnavailableTelegramRuntime() },
    }),
    automation: {
      event,
      orgId:
        event.scope.kind === "org" || event.scope.kind === "project"
          ? event.scope.orgId
          : undefined,
      binding,
      idempotencyKey,
      runtime,
    },
    automations: routeBacked?.automations ? { ...routeBacked.automations, runtime } : { runtime },
    otp: {
      runtime,
    },
  };
};
