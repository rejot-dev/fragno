import { InMemoryFs } from "just-bash";

import { createBashHost } from "@/fragno/bash-runtime/bash-host";
import type { PiBashRuntime } from "@/fragno/bash-runtime/pi-bash-runtime";

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
  AutomationCloudflareEnv,
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
import { AUTOMATION_TRIGGER_ORDER_LAST } from "../schema";

const normalizeOrgId = (orgId: string | undefined) => orgId?.trim() || undefined;

export type AutomationPiBashContext = {
  runtime: PiBashRuntime;
  bashEnv: AutomationBashEnvironment;
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
  pi?: {
    runtime: PiBashRuntime;
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
  sourceAdapter,
  cloudflareEnv,
  pi,
}: {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  runtime: AutomationBashRuntime;
  sourceAdapter: AnyAutomationSourceAdapter | undefined;
  cloudflareEnv: AutomationCloudflareEnv;
  pi?: AutomationPiBashContext;
}): AutomationBashHostContext => {
  const normalizedEvent: AutomationEvent = {
    ...event,
    orgId: normalizeOrgId(event.orgId),
  };

  const bashEnv: AutomationBashEnvironment = {
    ...binding.scriptEnv,
    AUTOMATION_EVENT_ID: normalizedEvent.id,
    AUTOMATION_ORG_ID: normalizedEvent.orgId,
    AUTOMATION_SOURCE: normalizedEvent.source,
    AUTOMATION_EVENT_TYPE: normalizedEvent.eventType,
    AUTOMATION_OCCURRED_AT: normalizedEvent.occurredAt,
    AUTOMATION_ACTOR_TYPE: normalizedEvent.actor?.type,
    AUTOMATION_EXTERNAL_ACTOR_ID: normalizedEvent.actor?.externalId,
    AUTOMATION_SUBJECT_USER_ID: normalizedEvent.subject?.userId,
    AUTOMATION_BINDING_ID: binding.id,
    AUTOMATION_SCRIPT_ID: binding.scriptId,
    AUTOMATION_SCRIPT_KEY: binding.scriptKey,
    AUTOMATION_SCRIPT_NAME: binding.scriptName,
    AUTOMATION_SCRIPT_PATH: binding.scriptPath,
    AUTOMATION_SCRIPT_VERSION:
      binding.scriptVersion != null ? String(binding.scriptVersion) : undefined,
    AUTOMATION_SCRIPT_AGENT: binding.scriptAgent ?? undefined,
    AUTOMATION_TRIGGER_ORDER:
      binding.triggerOrder != null &&
      Number.isFinite(binding.triggerOrder) &&
      binding.triggerOrder !== AUTOMATION_TRIGGER_ORDER_LAST
        ? String(binding.triggerOrder)
        : undefined,
    AUTOMATION_IDEMPOTENCY_KEY: idempotencyKey,
    ...sourceAdapter?.toBashEnv(normalizedEvent),
    ...pi?.bashEnv,
  };

  return {
    automation: {
      event: normalizedEvent,
      orgId: normalizedEvent.orgId,
      binding,
      idempotencyKey,
      bashEnv,
      cloudflareEnv,
      runtime,
    },
    automations: {
      runtime,
    },
    otp: {
      runtime,
    },
    ...(pi
      ? {
          pi: {
            runtime: pi.runtime,
          },
        }
      : {}),
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
  await Promise.all([
    fs.writeFile("/context/event.json", JSON.stringify(context.automation.event)),
    fs.writeFile("/context/payload.json", JSON.stringify(context.automation.event.payload ?? {})),
    fs.writeFile("/context/actor.json", JSON.stringify(context.automation.event.actor ?? null)),
    fs.writeFile("/context/subject.json", JSON.stringify(context.automation.event.subject ?? null)),
  ]);

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
