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
  createStorageBackedAutomationsBashRuntime,
  type AutomationIdentityBindingRecord,
  type AutomationIdentityStorageContext,
  type AutomationsBashRuntime,
  type ScriptRunnerRuntime,
} from "../../bash-runtime/automations-bash-runtime";
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
  AutomationCommandContext,
  AutomationTriggerBinding,
  BashAutomationCommandResult,
} from "../commands/types";
import {
  type AnyAutomationSourceAdapter,
  type AutomationBashEnvironment,
  type AutomationEvent,
  type AutomationSourceAdapterRegistry,
} from "../contracts";

const normalizeOrgId = (orgId: string | undefined) => orgId?.trim() || undefined;

export type AutomationPiBashContext = {
  runtime: PiBashRuntime;
  defaultAgent?: string;
};

export type BashAutomationRunResult = {
  eventId: string;
  scriptId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  commandCalls: BashAutomationCommandResult[];
};

export type AutomationBashRuntime = AutomationsBashRuntime & OtpBashRuntime & EventBashRuntime;

export type AutomationBashCommandContext = AutomationCommandContext & {
  runtime: AutomationBashRuntime;
};

export type AutomationBashHostContext = {
  automation: AutomationBashCommandContext;
  automations: {
    runtime: AutomationsBashRuntime;
    scriptRunner?: ScriptRunnerRuntime;
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

export const createAutomationBashRuntime = ({
  hookContext,
  env,
  event,
  sourceAdapters,
  sourceAdapter,
}: {
  hookContext: AutomationIdentityStorageContext;
  env?: CloudflareEnv;
  event: AutomationEvent;
  sourceAdapters: Partial<AutomationSourceAdapterRegistry>;
  sourceAdapter: AnyAutomationSourceAdapter | undefined;
}): AutomationBashRuntime => {
  const orgId = normalizeOrgId(event.orgId);

  return {
    ...createStorageBackedAutomationsBashRuntime({ hookContext }),
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
      sourceAdapters,
      sourceAdapter,
    }),
  };
};

export const createAutomationBashCommandContext = ({
  event,
  binding,
  idempotencyKey,
  runtime,
  env,
  pi,
  scriptRunner,
}: {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  runtime: AutomationBashRuntime;
  env?: CloudflareEnv;
  pi: AutomationPiBashContext | null;
  scriptRunner?: ScriptRunnerRuntime;
}): AutomationBashHostContext => {
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
      ...(scriptRunner ? { scriptRunner } : {}),
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
