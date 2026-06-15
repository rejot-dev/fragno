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

const normalizeOrgId = (orgId: string | undefined) => orgId?.trim() || undefined;

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
  const orgId = normalizeOrgId(event.orgId);
  const eventWithOrgId: AutomationEvent = {
    ...event,
    orgId,
  };
  const requireOrgRouteBackend = (toolName: string) => {
    if (!runtime) {
      throw new Error(`${toolName} is not configured`);
    }
    throw new Error(`${toolName} requires an organisation id`);
  };

  if (runtime && orgId) {
    const routeBacked = createRouteBackedRuntimeContext({ runtime, orgId });
    return {
      ...routeBacked.automations.runtime,
      ...routeBacked.otp.runtime,
      ...createEventRuntime({
        objects: runtime.objects,
        event: eventWithOrgId,
      }),
    };
  }

  return {
    get: async () => requireOrgRouteBackend("store.get"),
    set: async () => requireOrgRouteBackend("store.set"),
    delete: async () => requireOrgRouteBackend("store.delete"),
    list: async () => requireOrgRouteBackend("store.list"),
    createClaim: async () => requireOrgRouteBackend("otp.identity.create-claim"),
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
  const orgId = normalizeOrgId(event.orgId);
  const eventWithOrgId: AutomationEvent = {
    ...event,
    orgId,
  };

  const routeBacked =
    runtimeServices && orgId
      ? createRouteBackedRuntimeContext({
          runtime: runtimeServices,
          orgId,
          ...(pi ? { pi: { runtime: pi.runtime } } : {}),
        })
      : null;

  return {
    ...(routeBacked ?? {
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
      event: eventWithOrgId,
      orgId,
      binding,
      idempotencyKey,
      runtime,
    },
    automations: routeBacked?.automations
      ? { ...routeBacked.automations, runtime }
      : {
          runtime,
        },
    otp: {
      runtime,
    },
  };
};
