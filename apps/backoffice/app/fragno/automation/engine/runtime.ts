import type { PiBashRuntime } from "@/fragno/bash-runtime/pi-bash-runtime";
import {
  createResendRouteBashRuntime,
  createUnavailableResendBashRuntime,
  type ResendBashRuntime,
} from "@/fragno/bash-runtime/resend-bash-runtime";
import {
  createReson8RouteBashRuntime,
  createUnavailableReson8BashRuntime,
  type Reson8BashRuntime,
} from "@/fragno/bash-runtime/reson8-bash-runtime";
import {
  createTelegramBashRuntime,
  createUnavailableTelegramBashRuntime,
  type TelegramBashRuntime,
} from "@/fragno/bash-runtime/telegram-bash-runtime";

import {
  createEventBashRuntime,
  type AutomationEmitEventResult,
  type EventBashRuntime,
} from "../../bash-runtime/event-bash-runtime";
import {
  createOtpBashRuntime,
  type AutomationIdentityClaimRecord,
  type OtpBashRuntime,
} from "../../bash-runtime/otp-bash-runtime";
import type {
  AutomationIdentityBindingRecord,
  AutomationsRuntime,
} from "../../runtime-tools/families/automations";
import type { AutomationCommandContext, AutomationTriggerBinding } from "../commands/types";
import type { AutomationBashEnvironment, AutomationEvent } from "../contracts";
import {
  createStorageBackedAutomationsRuntime,
  type AutomationIdentityStorageContext,
} from "../identity-runtime";

const normalizeOrgId = (orgId: string | undefined) => orgId?.trim() || undefined;

export type AutomationPiBashContext = {
  runtime: PiBashRuntime;
  defaultAgent?: string;
};

export type AutomationRuntime = AutomationsRuntime & OtpBashRuntime & EventBashRuntime;

export type AutomationRuntimeCommandContext = AutomationCommandContext & {
  runtime: AutomationRuntime;
};

export type AutomationRuntimeHostContext = {
  automation: AutomationRuntimeCommandContext;
  automations: {
    runtime: AutomationsRuntime;
  };
  otp: {
    runtime: OtpBashRuntime;
  };
  pi: {
    runtime: PiBashRuntime;
  } | null;
  reson8: {
    runtime: Reson8BashRuntime;
  };
  resend: {
    runtime: ResendBashRuntime;
  };
  telegram: {
    runtime: TelegramBashRuntime;
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
      ? createOtpBashRuntime({
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
    ...createEventBashRuntime({
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
        ? { runtime: createReson8RouteBashRuntime({ env, orgId }) }
        : { runtime: createUnavailableReson8BashRuntime() },
    resend:
      env && orgId
        ? { runtime: createResendRouteBashRuntime({ env, orgId }) }
        : { runtime: createUnavailableResendBashRuntime() },
    telegram:
      env && orgId
        ? { runtime: createTelegramBashRuntime({ env, orgId }) }
        : { runtime: createUnavailableTelegramBashRuntime() },
  };
};
