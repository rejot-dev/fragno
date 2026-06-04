import type { PiRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import {
  createResendRouteRuntime,
  createUnavailableResendRuntime,
  type ResendRuntime,
} from "@/fragno/runtime-tools/families/resend-runtime";
import {
  createReson8RouteRuntime,
  createUnavailableReson8Runtime,
  type Reson8Runtime,
} from "@/fragno/runtime-tools/families/reson8-runtime";
import {
  createTelegramRuntime,
  createUnavailableTelegramRuntime,
  type TelegramRuntime,
} from "@/fragno/runtime-tools/families/telegram-runtime";

import type {
  AutomationCommandContext,
  AutomationTriggerBinding,
} from "../../runtime-tools/automation-types";
import type {
  AutomationIdentityBindingRecord,
  AutomationsRuntime,
} from "../../runtime-tools/families/automations";
import {
  createEventRuntime,
  type AutomationEmitEventResult,
  type EventRuntime,
} from "../../runtime-tools/families/event-runtime";
import {
  createOtpRuntime,
  type AutomationIdentityClaimRecord,
  type OtpRuntime,
} from "../../runtime-tools/families/otp-runtime";
import type { AutomationBashEnvironment, AutomationEvent } from "../contracts";
import {
  createStorageBackedAutomationsRuntime,
  type AutomationIdentityStorageContext,
} from "../identity-runtime";

const normalizeOrgId = (orgId: string | undefined) => orgId?.trim() || undefined;

export type AutomationPiBashContext = {
  runtime: PiRuntime;
  defaultAgent?: string;
};

export type AutomationRuntime = AutomationsRuntime & OtpRuntime & EventRuntime;

export type AutomationRuntimeCommandContext = AutomationCommandContext & {
  runtime: AutomationRuntime;
};

export type AutomationRuntimeHostContext = {
  automation: AutomationRuntimeCommandContext;
  automations: {
    runtime: AutomationsRuntime;
  };
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
  hookContext,
  env,
  event,
}: {
  hookContext: AutomationIdentityStorageContext;
  env?: CloudflareEnv;
  event: AutomationEvent;
}): AutomationRuntime => {
  const orgId = normalizeOrgId(event.orgId);

  return {
    ...createStorageBackedAutomationsRuntime({ hookContext }),
    ...(env && orgId
      ? createOtpRuntime({
          env,
          orgId,
        })
      : {
          createClaim: async () => {
            if (!env) {
              throw new Error("otp.identity.create-claim is not configured");
            }

            throw new Error("otp.identity.create-claim requires an organisation id");
          },
        }),
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

  const bashEnv: AutomationBashEnvironment = {
    ...binding.scriptEnv,
    ...(pi?.defaultAgent ? { PI_DEFAULT_AGENT: pi.defaultAgent } : {}),
  };

  return {
    automation: {
      event: normalizedEvent,
      orgId,
      binding,
      idempotencyKey,
      bashEnv,
      runtime,
    },
    automations: {
      runtime,
    },
    otp: {
      runtime,
    },
    pi: pi ? { runtime: pi.runtime } : null,
    reson8:
      env && orgId
        ? { runtime: createReson8RouteRuntime({ env, orgId }) }
        : { runtime: createUnavailableReson8Runtime() },
    resend:
      env && orgId
        ? { runtime: createResendRouteRuntime({ env, orgId }) }
        : { runtime: createUnavailableResendRuntime() },
    telegram:
      env && orgId
        ? { runtime: createTelegramRuntime({ env, orgId }) }
        : { runtime: createUnavailableTelegramRuntime() },
  };
};
