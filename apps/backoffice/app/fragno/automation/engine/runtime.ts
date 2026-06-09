import type { PiRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import {
  createUnavailableResendRuntime,
  type ResendRuntime,
} from "@/fragno/runtime-tools/families/resend-runtime";
import {
  createUnavailableReson8Runtime,
  type Reson8Runtime,
} from "@/fragno/runtime-tools/families/reson8-runtime";
import type { SandboxRuntime } from "@/fragno/runtime-tools/families/sandbox-runtime";
import {
  createUnavailableTelegramRuntime,
  type TelegramRuntime,
} from "@/fragno/runtime-tools/families/telegram-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import type {
  AutomationCommandContext,
  AutomationTriggerBinding,
} from "../../runtime-tools/automation-types";
import type {
  AutomationBindingsRuntime,
  AutomationIdentityBindingRecord,
} from "../../runtime-tools/families/automations-bindings";
import type { DurableHooksRuntime } from "../../runtime-tools/families/automations-durable-hooks";
import type { AutomationWorkflowRuntime } from "../../runtime-tools/families/automations-workflow";
import {
  createEventRuntime,
  type AutomationEmitEventResult,
  type EventRuntime,
} from "../../runtime-tools/families/event-runtime";
import {
  type AutomationIdentityClaimRecord,
  type OtpRuntime,
} from "../../runtime-tools/families/otp-runtime";
import type { AutomationEvent } from "../contracts";

const normalizeOrgId = (orgId: string | undefined) => orgId?.trim() || undefined;

export type AutomationPiBashContext = {
  runtime: PiRuntime;
};

export type AutomationRuntime = AutomationBindingsRuntime & OtpRuntime & EventRuntime;

export type AutomationRuntimeCommandContext = AutomationCommandContext & {
  runtime: AutomationRuntime;
};

export type AutomationRuntimeHostContext = {
  automation: AutomationRuntimeCommandContext;
  automations: {
    runtime: AutomationBindingsRuntime;
  };
  workflow?: {
    runtime: AutomationWorkflowRuntime;
  } | null;
  durableHooks?: {
    runtime: DurableHooksRuntime;
  } | null;
  otp: {
    runtime: OtpRuntime;
  };
  pi: {
    runtime: PiRuntime;
  } | null;
  reson8: {
    runtime: Reson8Runtime;
  };
  resend: {
    runtime: ResendRuntime;
  };
  sandbox?: {
    runtime: SandboxRuntime;
  } | null;
  telegram: {
    runtime: TelegramRuntime;
  };
};

export type {
  AutomationEmitEventResult,
  AutomationIdentityBindingRecord,
  AutomationIdentityClaimRecord,
};

export const createAutomationRuntime = ({
  env,
  event,
}: {
  env?: CloudflareEnv;
  event: AutomationEvent;
}): AutomationRuntime => {
  const orgId = normalizeOrgId(event.orgId);
  const requireOrgRouteBackend = (toolName: string) => {
    if (!env) {
      throw new Error(`${toolName} is not configured`);
    }
    throw new Error(`${toolName} requires an organisation id`);
  };

  if (env && orgId) {
    const routeBacked = createRouteBackedRuntimeContext({ env, orgId });
    return {
      ...routeBacked.automations.runtime,
      ...routeBacked.otp.runtime,
      ...createEventRuntime({
        env,
        event: {
          ...event,
          orgId,
        },
      }),
    };
  }

  return {
    lookupBinding: async () => requireOrgRouteBackend("identity.lookup-binding"),
    bindActor: async () => requireOrgRouteBackend("identity.bind-actor"),
    createClaim: async () => requireOrgRouteBackend("otp.identity.create-claim"),
    ...createEventRuntime({
      env,
      event: {
        ...event,
        orgId,
      },
    }),
  };
};

export const createAutomationExecutionContext = ({
  event,
  binding,
  idempotencyKey,
  runtime,
  env,
  pi,
}: {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  runtime: AutomationRuntime;
  env?: CloudflareEnv;
  pi: AutomationPiBashContext | null;
}): AutomationRuntimeHostContext => {
  const normalizedEvent: AutomationEvent = {
    ...event,
    orgId: normalizeOrgId(event.orgId),
  };

  const orgId = normalizedEvent.orgId;

  const routeBacked =
    env && orgId
      ? createRouteBackedRuntimeContext({
          env,
          orgId,
          ...(pi ? { pi: { runtime: pi.runtime } } : {}),
        })
      : null;

  return {
    automation: {
      event: normalizedEvent,
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
    workflow: routeBacked?.workflow ?? null,
    durableHooks: routeBacked?.durableHooks ?? null,
    otp: {
      runtime,
    },
    pi: routeBacked?.pi ?? null,
    reson8: routeBacked?.reson8 ?? { runtime: createUnavailableReson8Runtime() },
    resend: routeBacked?.resend ?? { runtime: createUnavailableResendRuntime() },
    sandbox: routeBacked?.sandbox ?? null,
    telegram: routeBacked?.telegram ?? { runtime: createUnavailableTelegramRuntime() },
  };
};
