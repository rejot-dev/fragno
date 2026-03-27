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
import { getSourceAdapter, type AutomationEvent } from "@/fragno/automation/contracts";
import {
  createAutomationBashCommandContext,
  type AutomationBashHostContext,
  type AutomationBashRuntime,
  type AutomationPiBashContext,
  type BashAutomationRunResult,
} from "@/fragno/automation/engine/bash";

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
import { createPiBashCommands, type RegisteredPiBashCommandContext } from "./pi-bash-runtime";
import {
  createResendBashCommands,
  type RegisteredResendBashCommandContext,
} from "./resend-bash-runtime";
import {
  createTelegramBashCommands,
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
  resend: RegisteredResendBashCommandContext | null;
  telegram: RegisteredTelegramBashCommandContext | null;
};

export const EMPTY_BASH_HOST_CONTEXT: BashHostContext = {
  automation: null,
  automations: null,
  otp: null,
  pi: null,
  resend: null,
  telegram: null,
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
      customCommands: [
        ...createAutomationsBashCommands(commandInput),
        ...createOtpBashCommands(commandInput),
        ...createEventBashCommands(commandInput),
        ...createPiBashCommands(commandInput),
        ...createResendBashCommands(commandInput),
        ...createTelegramBashCommands(commandInput),
      ],
    }),
    sessionId: input.sessionId,
    context: input.context,
    commandCallsResult,
  };
};

// ---------------------------------------------------------------------------
// Automation bash execution (mounts /context temporarily on the master FS)
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

export const executeBashAutomation = async ({
  script,
  context,
  masterFs,
}: {
  script: string;
  context: AutomationBashHostContext;
  masterFs: MasterFileSystem;
}): Promise<BashAutomationRunResult> => {
  const eventJson = JSON.stringify(context.automation.event);
  const tempMounts: string[] = [];

  const mountIfMissing = (mount: ResolvedFileMount) => {
    if (!masterFs.mounts.some((m) => m.mountPoint === mount.mountPoint)) {
      masterFs.mount(mount);
      tempMounts.push(mount.mountPoint);
    }
  };

  mountIfMissing(createContextMount(eventJson));
  mountIfMissing(createDevMount());

  try {
    const { bash, commandCallsResult } = createBashHost({
      fs: masterFs,
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
  } finally {
    for (const mp of tempMounts) {
      masterFs.unmount(mp);
    }
  }
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
  createBashRuntime: (
    event: AutomationEvent,
  ) => AutomationBashRuntime | Promise<AutomationBashRuntime>;
  createPiAutomationContext?: (input: {
    event: AutomationEvent;
    idempotencyKey: string;
  }) => Promise<AutomationPiBashContext | undefined> | AutomationPiBashContext | undefined;
};

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

    let scriptBody: string;
    try {
      scriptBody = await fileSystem.readFile(absoluteScriptPath, "utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read script file '${absoluteScriptPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const runtime = await options.createBashRuntime(parsedEvent);

    const idempotencyKey = `script-run:${parsedEvent.id}:${crypto.randomUUID()}`;
    const pi =
      (await options.createPiAutomationContext?.({ event: parsedEvent, idempotencyKey })) ?? null;

    const context = createAutomationBashCommandContext({
      event: parsedEvent,
      binding: {
        source: parsedEvent.source,
        eventType: parsedEvent.eventType,
        scriptId: `manual:${absoluteScriptPath}`,
        scriptKey: script,
        scriptName: script,
        scriptPath: absoluteScriptPath,
      },
      idempotencyKey,
      runtime,
      env: options.env,
      pi,
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

export type CreateInteractiveBashHostInput = {
  fs: IFileSystem;
  env: CloudflareEnv;
  orgId: string;
  sessionId?: string;
  context: BashHostContext;
};

export const createInteractiveBashHost = (input: CreateInteractiveBashHostInput): BashHost => {
  const scriptRunner = createScriptRunnerRuntime({
    fileSystemConfig: { automationFileSystem: input.fs },
    env: input.env,
    createBashRuntime: (event) => ({
      ...createRouteBackedAutomationsBashRuntime({ env: input.env, orgId: input.orgId }),
      ...createOtpBashRuntime({ env: input.env, orgId: input.orgId }),
      ...createEventBashRuntime({
        env: input.env,
        event: { ...event, orgId: input.orgId },
        sourceAdapters: {},
        sourceAdapter: getSourceAdapter({}, event.source),
      }),
    }),
  });

  return createBashHost({
    fs: input.fs,
    sessionId: input.sessionId,
    context: {
      ...input.context,
      automations: input.context.automations
        ? { ...input.context.automations, scriptRunner }
        : null,
    },
  });
};
