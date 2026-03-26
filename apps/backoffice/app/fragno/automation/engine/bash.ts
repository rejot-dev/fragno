import { InMemoryFs } from "just-bash";

import { createBashHost } from "@/fragno/bash-runtime/bash-host";
import type { PiBashRuntime } from "@/fragno/bash-runtime/pi-bash-runtime";
import {
  createResendRouteBashRuntime,
  createUnavailableResendBashRuntime,
  type ResendBashRuntime,
} from "@/fragno/bash-runtime/resend-bash-runtime";
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
import type {
  AnyAutomationSourceAdapter,
  AutomationBashEnvironment,
  AutomationEvent,
  AutomationSourceAdapterRegistry,
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
  };
  otp: {
    runtime: OtpBashRuntime;
  };
  pi: {
    runtime: PiBashRuntime;
  } | null;
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
}: {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  runtime: AutomationBashRuntime;
  env?: CloudflareEnv;
  pi: AutomationPiBashContext | null;
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
    },
    otp: {
      runtime,
    },
    pi: pi ? { runtime: pi.runtime } : null,
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

export const executeBashAutomation = async ({
  script,
  context,
}: {
  script: string;
  context: AutomationBashHostContext;
}): Promise<BashAutomationRunResult> => {
  const fs = new InMemoryFs();
  await fs.mkdir("/context", { recursive: true });
  await fs.writeFile("/context/event.json", JSON.stringify(context.automation.event));

  const { bash, commandCallsResult } = createBashHost({
    fs,
    env: Object.fromEntries(
      Object.entries(context.automation.bashEnv).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    ),
    context,
  });
  const result = await bash.exec(script);

  return {
    eventId: context.automation.event.id,
    scriptId: context.automation.binding.scriptId,
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    commandCalls: commandCallsResult,
  };
};
