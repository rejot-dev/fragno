import { Bash } from "just-bash";

import type { IFileSystem } from "@/files/interface";
import { MasterFileSystem } from "@/files/master-file-system";
import { normalizeMountedFileSystem } from "@/files/mounted-file-system";
import type { ResolvedFileMount } from "@/files/types";
import {
  AUTOMATION_WORKSPACE_ROOT,
  resolveAutomationFileSystem,
  type AutomationFileSystemConfig,
} from "@/fragno/automation/catalog";
import type { ScriptRunArgs } from "@/fragno/automation/commands/types";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import type { BashAutomationRunResult } from "@/fragno/automation/engine/bash";

import type { BashAutomationCommandResult } from "../automation/commands/types";
import {
  createAutomationsBashCommands,
  createRouteBackedAutomationsBashRuntime,
  type RegisteredAutomationsBashCommandContext,
  type ScriptRunnerRuntime,
} from "./automations-bash-runtime";
import {
  createEventBashCommands,
  createEventBashRuntime,
  type RegisteredEventBashCommandContext,
} from "./event-bash-runtime";
import {
  createOtpBashCommands,
  createOtpBashRuntime,
  type RegisteredOtpBashCommandContext,
} from "./otp-bash-runtime";
import {
  createPiBashCommands,
  createPiRouteBashRuntime,
  type RegisteredPiBashCommandContext,
} from "./pi-bash-runtime";
import {
  createResendBashCommands,
  createResendRouteBashRuntime,
  type RegisteredResendBashCommandContext,
} from "./resend-bash-runtime";
import {
  createReson8BashCommands,
  createReson8RouteBashRuntime,
  type RegisteredReson8BashCommandContext,
} from "./reson8-bash-runtime";
import {
  createTelegramBashCommands,
  createTelegramBashRuntime,
  type RegisteredTelegramBashCommandContext,
} from "./telegram-bash-runtime";

// ---------------------------------------------------------------------------
// Low-level bash host
// ---------------------------------------------------------------------------

export type BashHostContext = {
  automation: RegisteredEventBashCommandContext | null;
  automations: RegisteredAutomationsBashCommandContext | null;
  otp: RegisteredOtpBashCommandContext | null;
  pi: RegisteredPiBashCommandContext | null;
  reson8: RegisteredReson8BashCommandContext | null;
  resend: RegisteredResendBashCommandContext | null;
  telegram: RegisteredTelegramBashCommandContext | null;
};

export const EMPTY_BASH_HOST_CONTEXT: BashHostContext = {
  automation: null,
  automations: null,
  otp: null,
  pi: null,
  reson8: null,
  resend: null,
  telegram: null,
};

export type InteractiveBashCommandContext = Omit<BashHostContext, "automation"> & {
  automation: null;
  automations: NonNullable<BashHostContext["automations"]>;
  otp: NonNullable<BashHostContext["otp"]>;
  pi: NonNullable<BashHostContext["pi"]>;
  reson8: NonNullable<BashHostContext["reson8"]>;
  resend: NonNullable<BashHostContext["resend"]>;
  telegram: NonNullable<BashHostContext["telegram"]>;
};

type BashOptions = NonNullable<ConstructorParameters<typeof Bash>[0]>;

type CreateBashHostInput = {
  fs: BashOptions["fs"];
  env?: BashOptions["env"];
  sessionId?: string;
  context: BashHostContext;
  commandCallsResult?: BashAutomationCommandResult[];
};

export type BashHost = {
  bash: Bash;
  sessionId?: string;
  context: BashHostContext;
  commandCallsResult: BashAutomationCommandResult[];
};

export type BashCommandFactoryInput = {
  sessionId?: string;
  commandCallsResult: BashAutomationCommandResult[];
  context: BashHostContext;
};

type BashHostModuleId = keyof BashHostContext;
type BashHostCustomCommand = ReturnType<typeof createAutomationsBashCommands>[number];
type BashHostModule = {
  id: BashHostModuleId;
  selectContext: (context: BashHostContext) => BashHostContext[BashHostModuleId];
  createCommands: (input: BashCommandFactoryInput) => BashHostCustomCommand[];
};

const BASH_HOST_MODULES: BashHostModule[] = [
  {
    id: "automations",
    selectContext: (context) => context.automations,
    createCommands: createAutomationsBashCommands,
  },
  {
    id: "otp",
    selectContext: (context) => context.otp,
    createCommands: createOtpBashCommands,
  },
  {
    id: "automation",
    selectContext: (context) => context.automation,
    createCommands: createEventBashCommands,
  },
  {
    id: "pi",
    selectContext: (context) => context.pi,
    createCommands: createPiBashCommands,
  },
  {
    id: "reson8",
    selectContext: (context) => context.reson8,
    createCommands: createReson8BashCommands,
  },
  {
    id: "resend",
    selectContext: (context) => context.resend,
    createCommands: createResendBashCommands,
  },
  {
    id: "telegram",
    selectContext: (context) => context.telegram,
    createCommands: createTelegramBashCommands,
  },
];

const createRegisteredBashCommands = (input: BashCommandFactoryInput) => {
  return BASH_HOST_MODULES.flatMap((module) => {
    if (!module.selectContext(input.context)) {
      return [];
    }

    return module.createCommands(input);
  });
};

export const createRouteBackedInteractiveBashContext = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): InteractiveBashCommandContext => ({
  automation: null,
  automations: {
    runtime: createRouteBackedAutomationsBashRuntime({ env, orgId }),
  },
  otp: {
    runtime: createOtpBashRuntime({ env, orgId }),
  },
  pi: {
    runtime: createPiRouteBashRuntime({ env, orgId }),
  },
  reson8: {
    runtime: createReson8RouteBashRuntime({ env, orgId }),
  },
  resend: {
    runtime: createResendRouteBashRuntime({ env, orgId }),
  },
  telegram: {
    runtime: createTelegramBashRuntime({ env, orgId }),
  },
});

export const createBashHost = (input: CreateBashHostInput): BashHost => {
  const commandCallsResult = input.commandCallsResult ?? [];
  const commandInput: BashCommandFactoryInput = {
    sessionId: input.sessionId,
    commandCallsResult,
    context: input.context,
  };

  return {
    bash: new Bash({
      fs: input.fs,
      env: input.env,
      customCommands: createRegisteredBashCommands(commandInput),
    }),
    sessionId: input.sessionId,
    context: input.context,
    commandCallsResult,
  };
};

// ---------------------------------------------------------------------------
// Automation bash execution (isolates per-run /context and /dev mounts)
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Creates a read-only mount containing a single `/context/event.json` file.
 * Uses a plain-object filesystem (no InMemoryFs) to avoid `this`-binding issues
 * when methods are wrapped by `normalizeMountedFileSystem`.
 */
const createContextMount = (eventJson: string): ResolvedFileMount => {
  const buf = TEXT_ENCODER.encode(eventJson);
  const now = new Date();
  const EVENT_FILE = "/context/event.json";
  const MOUNT = "/context";

  return {
    id: "automation-context",
    kind: "custom",
    mountPoint: MOUNT,
    title: "Automation Context",
    readOnly: true,
    persistence: "session",
    fs: normalizeMountedFileSystem(
      {
        readFile: async () => eventJson,
        readFileBuffer: async () => buf,
        stat: async (path) => ({
          isFile: path === EVENT_FILE,
          isDirectory: path === MOUNT,
          isSymbolicLink: false,
          mode: 0o444,
          size: path === EVENT_FILE ? buf.length : 0,
          mtime: now,
        }),
        readdir: async () => ["event.json"],
        getAllPaths: () => [MOUNT, EVENT_FILE],
      },
      { readOnly: true },
    ),
  };
};

/**
 * Creates a writable `/dev` mount with `/dev/null` and `/dev/zero`.
 *
 * `/dev/stdin`, `/dev/stdout`, `/dev/stderr` are intentionally omitted: just-bash
 * treats them as plain files (not wired to the shell's I/O streams), so including
 * them would silently swallow output that the script author meant for stderr/stdout.
 * The standard `>&2` redirection works without these files.
 */
const DEV_ENTRIES = ["null", "zero"] as const;

const createDevMount = (): ResolvedFileMount => {
  const files = new Map<string, Uint8Array>(
    DEV_ENTRIES.map((name) => [`/dev/${name}`, new Uint8Array(0)]),
  );
  const now = new Date();

  return {
    id: "dev",
    kind: "custom",
    mountPoint: "/dev",
    title: "Device Files",
    readOnly: false,
    persistence: "session",
    fs: normalizeMountedFileSystem(
      {
        readFile: async (path) => TEXT_DECODER.decode(files.get(path) ?? new Uint8Array(0)),
        readFileBuffer: async (path) => files.get(path) ?? new Uint8Array(0),
        writeFile: async (path, content) => {
          if (path === "/dev/null") {
            return;
          }
          files.set(path, typeof content === "string" ? TEXT_ENCODER.encode(content) : content);
        },
        stat: async (path) => ({
          isFile: files.has(path),
          isDirectory: path === "/dev",
          isSymbolicLink: false,
          mode: 0o666,
          size: files.get(path)?.length ?? 0,
          mtime: now,
        }),
        readdir: async () => [...DEV_ENTRIES],
        mkdir: async () => {},
        getAllPaths: () => ["/dev", ...files.keys()],
      },
      { readOnly: false },
    ),
  };
};

type ExecutableAutomationBashHostContext = BashHostContext & {
  automation: NonNullable<BashHostContext["automation"]>;
};

const createExecutionFileSystem = ({
  masterFs,
  eventJson,
}: {
  masterFs: MasterFileSystem;
  eventJson: string;
}): MasterFileSystem => {
  const baseMounts = masterFs.mounts.filter((mount) => mount.mountPoint !== "/context");
  const executionFs = new MasterFileSystem({ mounts: [...baseMounts] });

  executionFs.mount(createContextMount(eventJson));

  if (!baseMounts.some((mount) => mount.mountPoint === "/dev")) {
    executionFs.mount(createDevMount());
  }

  return executionFs;
};

export const executeBashAutomation = async ({
  script,
  context,
  masterFs,
}: {
  script: string;
  context: ExecutableAutomationBashHostContext;
  masterFs: MasterFileSystem;
}): Promise<BashAutomationRunResult> => {
  const eventJson = JSON.stringify(context.automation.event);
  const executionFs = createExecutionFileSystem({ masterFs, eventJson });

  const { bash, commandCallsResult } = createBashHost({
    fs: executionFs,
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

// ---------------------------------------------------------------------------
// Script runner runtime (reads script + event from filesystem, sub-executes)
// ---------------------------------------------------------------------------

const resolveScriptPath = (scriptArg: string): string => {
  const trimmed = scriptArg.trim();
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `${AUTOMATION_WORKSPACE_ROOT}/${trimmed}`;
};

export type CreateScriptRunnerRuntimeOptions = {
  fileSystemConfig: AutomationFileSystemConfig;
  env?: CloudflareEnv;
  parentOrgId: string;
  parentContext: BashHostContext;
};

const normalizeInteractiveScriptRunEvent = ({
  event,
  eventPath,
  parentOrgId,
}: {
  event: AutomationEvent;
  eventPath: string;
  parentOrgId: string;
}): AutomationEvent => {
  const normalizedParentOrgId = parentOrgId.trim();
  const fixtureOrgId = event.orgId?.trim() || undefined;

  if (!normalizedParentOrgId) {
    throw new Error("scripts.run requires an interactive organisation id");
  }

  if (fixtureOrgId && fixtureOrgId !== normalizedParentOrgId) {
    throw new Error(
      `Event file '${eventPath}' has orgId '${fixtureOrgId}', but scripts.run is scoped to interactive org '${normalizedParentOrgId}'.`,
    );
  }

  return {
    ...event,
    orgId: normalizedParentOrgId,
  };
};

const createInteractiveScriptRunContext = ({
  event,
  absoluteScriptPath,
  scriptArg,
  idempotencyKey,
  env,
  parentContext,
}: {
  event: AutomationEvent;
  absoluteScriptPath: string;
  scriptArg: string;
  idempotencyKey: string;
  env?: CloudflareEnv;
  parentContext: BashHostContext;
}): ExecutableAutomationBashHostContext => ({
  automation: {
    event,
    orgId: event.orgId?.trim() || undefined,
    binding: {
      source: event.source,
      eventType: event.eventType,
      scriptId: `manual:${absoluteScriptPath}`,
      scriptKey: scriptArg,
      scriptName: scriptArg,
      scriptPath: absoluteScriptPath,
    },
    idempotencyKey,
    bashEnv: {},
    runtime: createEventBashRuntime({ env, event }),
  },
  automations: parentContext.automations
    ? {
        runtime: parentContext.automations.runtime,
      }
    : null,
  otp: parentContext.otp,
  pi: parentContext.pi,
  reson8: parentContext.reson8,
  resend: parentContext.resend,
  telegram: parentContext.telegram,
});

export const createScriptRunnerRuntime = (
  options: CreateScriptRunnerRuntimeOptions,
): ScriptRunnerRuntime => ({
  runScript: async ({ script, event: eventPath }: ScriptRunArgs) => {
    const absoluteScriptPath = resolveScriptPath(script);

    const fileSystem = await resolveAutomationFileSystem(options.fileSystemConfig, {
      orgId: undefined,
      purpose: "runtime",
    });

    let eventContent: string;
    try {
      eventContent = await fileSystem.readFile(eventPath, "utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read event file '${eventPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsedEvent: AutomationEvent;
    try {
      parsedEvent = JSON.parse(eventContent) as AutomationEvent;
    } catch (error) {
      throw new Error(
        `Event file '${eventPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!parsedEvent.id || !parsedEvent.source || !parsedEvent.eventType) {
      throw new Error(
        `Event file '${eventPath}' is missing required fields (id, source, eventType)`,
      );
    }

    const normalizedEvent = normalizeInteractiveScriptRunEvent({
      event: parsedEvent,
      eventPath,
      parentOrgId: options.parentOrgId,
    });

    let scriptBody: string;
    try {
      scriptBody = await fileSystem.readFile(absoluteScriptPath, "utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read script file '${absoluteScriptPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const idempotencyKey = `script-run:${normalizedEvent.id}:${crypto.randomUUID()}`;

    const context = createInteractiveScriptRunContext({
      event: normalizedEvent,
      absoluteScriptPath,
      scriptArg: script,
      idempotencyKey,
      env: options.env,
      parentContext: options.parentContext,
    });

    if (!(fileSystem instanceof MasterFileSystem)) {
      throw new Error(
        "executeBashAutomation requires a MasterFileSystem but received a different filesystem type.",
      );
    }

    return executeBashAutomation({ script: scriptBody, context, masterFs: fileSystem });
  },
});

// ---------------------------------------------------------------------------
// Interactive bash host (dashboard / Pi sessions)
// ---------------------------------------------------------------------------

export type CreateInteractiveBashContextInput = {
  fs: IFileSystem;
  env: CloudflareEnv;
  orgId: string;
  context?: BashHostContext;
};

export const createInteractiveBashContext = (
  input: CreateInteractiveBashContextInput,
): BashHostContext => {
  const baseContext =
    input.context ??
    createRouteBackedInteractiveBashContext({ env: input.env, orgId: input.orgId });

  const scriptRunner = createScriptRunnerRuntime({
    fileSystemConfig: { automationFileSystem: input.fs },
    env: input.env,
    parentOrgId: input.orgId,
    parentContext: baseContext,
  });

  return {
    ...baseContext,
    automations: baseContext.automations ? { ...baseContext.automations, scriptRunner } : null,
  };
};

export type CreateInteractiveBashHostInput = {
  fs: IFileSystem;
  env: CloudflareEnv;
  orgId: string;
  sessionId?: string;
  context?: BashHostContext;
};

export const createInteractiveBashHost = (input: CreateInteractiveBashHostInput): BashHost => {
  return createBashHost({
    fs: input.fs,
    sessionId: input.sessionId,
    context: createInteractiveBashContext(input),
  });
};
