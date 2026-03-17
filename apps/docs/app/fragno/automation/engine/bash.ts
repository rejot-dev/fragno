import { Bash, InMemoryFs } from "just-bash";

import {
  createAutomationCommands,
  type AutomationCommandHandlers,
  type BashAutomationCommandResult,
  type EventEmitArgs,
  type EventReplyArgs,
  type IdentityBindActorArgs,
  type IdentityCreateClaimArgs,
  type IdentityLookupBindingArgs,
} from "../command-spec";
import {
  getSourceAdapter,
  type AnyAutomationSourceAdapter,
  type AutomationBashEnvironment,
  type AutomationEvent,
  type AutomationSourceAdapterRegistry,
} from "../contracts";

type AutomationBashServices = {
  sourceAdapters?: Partial<AutomationSourceAdapterRegistry>;
};

type AutomationTriggerBinding = {
  source: string;
  eventType: string;
  scriptId: string;
};

const buildCanonicalBashEnv = ({
  event,
  binding,
  idempotencyKey,
}: {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
}): AutomationBashEnvironment => ({
  AUTOMATION_EVENT_ID: event.id,
  AUTOMATION_ORG_ID: event.orgId,
  AUTOMATION_SOURCE: event.source,
  AUTOMATION_EVENT_TYPE: event.eventType,
  AUTOMATION_OCCURRED_AT: event.occurredAt,
  AUTOMATION_ACTOR_TYPE: event.actor?.type,
  AUTOMATION_EXTERNAL_ACTOR_ID: event.actor?.externalId,
  AUTOMATION_SUBJECT_USER_ID: event.subject?.userId,
  AUTOMATION_SCRIPT_ID: binding.scriptId,
  AUTOMATION_IDEMPOTENCY_KEY: idempotencyKey,
});

const toExecEnv = (bashEnv: AutomationBashEnvironment): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(bashEnv).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
};

const writeContextFiles = async ({ fs, event }: { fs: InMemoryFs; event: AutomationEvent }) => {
  await fs.mkdir("/context", { recursive: true });
  await Promise.all([
    fs.writeFile("/context/event.json", JSON.stringify(event)),
    fs.writeFile("/context/payload.json", JSON.stringify(event.payload ?? {})),
    fs.writeFile("/context/actor.json", JSON.stringify(event.actor ?? null)),
    fs.writeFile("/context/subject.json", JSON.stringify(event.subject ?? null)),
  ]);
};

export type BashAutomationRunResult = {
  eventId: string;
  scriptId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  commandCalls: BashAutomationCommandResult[];
};

export type AutomationIdentityBindingRecord = {
  id?: unknown;
  source: string;
  externalActorId: string;
  userId: string;
  status: string;
  linkedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type AutomationIdentityClaimRecord = {
  url: string;
  externalId: string;
  code: string;
  type?: string;
  expiresAt?: string;
};

export type AutomationEmitEventResult = {
  accepted: boolean;
  eventId: string;
  orgId?: string;
  source: string;
  eventType: string;
};

export type AutomationBashRuntime = {
  lookupBinding: (
    input: IdentityLookupBindingArgs,
  ) => Promise<AutomationIdentityBindingRecord | null>;
  bindActor: (input: IdentityBindActorArgs) => Promise<AutomationIdentityBindingRecord>;
  createClaim: (input: IdentityCreateClaimArgs) => Promise<AutomationIdentityClaimRecord>;
  emitEvent: (input: EventEmitArgs) => Promise<AutomationEmitEventResult>;
};

type AutomationBashCommandContext = {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  runtime: AutomationBashRuntime;
  services: AutomationBashServices;
  sourceAdapter?: AnyAutomationSourceAdapter;
  bashEnv?: AutomationBashEnvironment;
};

const automationCommandHandlers: AutomationCommandHandlers<AutomationBashCommandContext> = {
  "identity.create-claim": async (command, context) => {
    return {
      data: await context.runtime.createClaim(command.args),
    };
  },
  "identity.lookup-binding": async (command, context) => {
    const binding = await context.runtime.lookupBinding(command.args);
    if (!binding || binding.status !== "linked") {
      return {
        exitCode: 1,
      };
    }

    return {
      data: binding,
    };
  },
  "identity.bind-actor": async (command, context) => {
    return {
      data: await context.runtime.bindActor(command.args),
    };
  },
  "event.reply": async (command, context) => {
    const args = command.args as EventReplyArgs;
    const replySource = args.source ?? context.event.source;
    const sourceAdapter =
      replySource === context.event.source
        ? (context.sourceAdapter ?? getSourceAdapter(context.services.sourceAdapters, replySource))
        : getSourceAdapter(context.services.sourceAdapters, replySource);
    const externalActorId = args.externalActorId ?? context.event.actor?.externalId;

    if (typeof args.text !== "string" || args.text.length === 0) {
      throw new Error("event.reply requires a non-empty --text value");
    }

    if (!sourceAdapter?.reply) {
      throw new Error(`No reply handler is registered for source: ${replySource}`);
    }

    if (!externalActorId) {
      throw new Error("Cannot call event.reply because no external actor id is available");
    }

    await sourceAdapter.reply({
      event: context.event,
      externalActorId,
      text: args.text,
    });

    return {
      data: { ok: true },
    };
  },
  "event.emit": async (command, context) => {
    return {
      data: await context.runtime.emitEvent(command.args),
    };
  },
};

export const createBashAutomationEngine = (services: AutomationBashServices) => ({
  execute: async ({
    event,
    binding,
    idempotencyKey,
    runtime,
    sourceAdapter,
    script,
  }: {
    event: AutomationEvent;
    binding: AutomationTriggerBinding;
    idempotencyKey: string;
    runtime: AutomationBashRuntime;
    sourceAdapter?: AnyAutomationSourceAdapter;
    script?: string;
  }): Promise<BashAutomationRunResult> => {
    const activeSourceAdapter =
      sourceAdapter ?? getSourceAdapter(services.sourceAdapters, event.source);
    const commandCallsResult: BashAutomationCommandResult[] = [];
    const bashEnv: AutomationBashEnvironment = {
      ...buildCanonicalBashEnv({ event, binding, idempotencyKey }),
      ...activeSourceAdapter?.toBashEnv(event),
    };
    const customCommands = createAutomationCommands(
      automationCommandHandlers,
      {
        event,
        binding,
        idempotencyKey,
        runtime,
        services,
        sourceAdapter: activeSourceAdapter,
        bashEnv,
      },
      commandCallsResult,
    );

    const fs = new InMemoryFs();
    await writeContextFiles({ fs, event });
    const bash = new Bash({ fs, customCommands, env: toExecEnv(bashEnv) });
    const result = await bash.exec(script ?? "");

    return {
      eventId: event.id,
      scriptId: binding.scriptId,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      commandCalls: commandCallsResult,
    };
  },
});
