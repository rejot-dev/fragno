import { Bash, defineCommand } from "just-bash";

import type { IFileSystem } from "@/files/interface";
import { MasterFileSystem } from "@/files/master-file-system";
import {
  AUTOMATION_WORKSPACE_ROOT,
  resolveAutomationFileSystem,
  type AutomationFileSystemConfig,
  type AutomationScriptEngine,
} from "@/fragno/automation/catalog";
import type { ScriptRunArgs } from "@/fragno/automation/commands/types";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { createAutomationExecutionFileSystem } from "@/fragno/automation/engine/execution-file-system";
import { createRouteBackedAutomationsRuntime } from "@/fragno/automation/identity-runtime";
import {
  createAutomationRunResult,
  type AutomationRunResult,
} from "@/fragno/automation/run-result";
import { automationsRuntimeTools } from "@/fragno/runtime-tools/families/automations";
import type {
  AutomationsRuntime,
  ScriptRunnerRuntime,
} from "@/fragno/runtime-tools/families/automations";
import { eventRuntimeTools } from "@/fragno/runtime-tools/families/event";
import { otpRuntimeTools } from "@/fragno/runtime-tools/families/otp";
import {
  parseTelegramFileDownloadBashArgs,
  telegramDownloadRuntimeTool,
  telegramGenericBashRuntimeTools,
} from "@/fragno/runtime-tools/families/telegram";
import { createBackofficeBashCommands } from "@/fragno/runtime-tools/runtime-tools";

import {
  buildCommandHelp,
  ensureTrailingNewline,
  hasHelpOption,
  parseCliTokens,
} from "../automation/commands/cli";
import type {
  AutomationCommandContext,
  BashAutomationCommandResult,
} from "../automation/commands/types";
import { createEventBashRuntime, type EventBashRuntime } from "./event-bash-runtime";
import { createOtpBashRuntime, type RegisteredOtpBashCommandContext } from "./otp-bash-runtime";
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
  createTelegramBashRuntime,
  throwOnTelegramDownloadError,
  type RegisteredTelegramBashCommandContext,
} from "./telegram-bash-runtime";

// ---------------------------------------------------------------------------
// Low-level bash host
// ---------------------------------------------------------------------------

export type RegisteredAutomationsBashCommandContext = {
  runtime: AutomationsRuntime;
  scriptRunner?: ScriptRunnerRuntime;
};

export type RegisteredEventBashCommandContext = AutomationCommandContext & {
  runtime: EventBashRuntime;
};

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

const createAutomationsBashCommands = (input: BashCommandFactoryInput) => {
  const automationsContext = input.context.automations;
  if (!automationsContext) {
    return [];
  }

  return createBackofficeBashCommands({
    tools: automationsRuntimeTools,
    context: {
      runtimes: {
        automations: automationsContext.runtime,
      },
      scriptRunner: automationsContext.scriptRunner,
    },
    commandCallsResult: input.commandCallsResult,
  });
};

const createOtpBashCommands = (input: BashCommandFactoryInput) => {
  const otpContext = input.context.otp;
  if (!otpContext) {
    return [];
  }

  return createBackofficeBashCommands({
    tools: otpRuntimeTools,
    context: {
      runtimes: {
        otp: otpContext.runtime,
      },
    },
    commandCallsResult: input.commandCallsResult,
  });
};

const createEventBashCommands = (input: BashCommandFactoryInput) => {
  const automationContext = input.context.automation;
  if (!automationContext) {
    return [];
  }

  return createBackofficeBashCommands({
    tools: eventRuntimeTools,
    context: {
      runtimes: {
        event: automationContext.runtime,
      },
    },
    commandCallsResult: input.commandCallsResult,
  });
};

const bytesToBinaryString = (bytes: Uint8Array) => {
  if (bytes.byteLength === 0) {
    return "";
  }

  const chunkSize = 0x8000;
  let result = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return result;
};

const createTelegramDownloadCommand = (
  telegramContext: RegisteredTelegramBashCommandContext,
  commandCallsResult: BashAutomationCommandResult[],
) => {
  const bash = telegramDownloadRuntimeTool.bash!;

  return defineCommand(bash.command, async (args, ctx) => {
    const parsed = parseCliTokens(args);

    if (hasHelpOption(parsed)) {
      const helpText = buildCommandHelp({
        name: bash.command,
        help: bash.help,
        parse: (rawArgs) => ({
          name: bash.command,
          args: bash.parse(rawArgs),
          output: { format: "text" },
          rawArgs,
        }),
      });
      commandCallsResult.push({
        command: bash.command,
        output: helpText.replace(/\n$/, ""),
        exitCode: 0,
      });
      return { stdout: helpText, stderr: "", exitCode: 0 };
    }

    try {
      const { fileId, outputPath } = parseTelegramFileDownloadBashArgs(args);
      const response = await telegramContext.runtime.downloadFile({ fileId });
      if (!response.ok) {
        await throwOnTelegramDownloadError(response);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (outputPath) {
        const resolvedPath = ctx.fs.resolvePath(ctx.cwd, outputPath);
        await ctx.fs.writeFile(resolvedPath, bytes);

        const message = `Downloaded ${bytes.byteLength} bytes to ${resolvedPath}\n`;
        commandCallsResult.push({
          command: bash.command,
          output: message.replace(/\n$/, ""),
          exitCode: 0,
        });
        return { stdout: message, stderr: "", exitCode: 0 };
      }

      commandCallsResult.push({ command: bash.command, output: "<binary>", exitCode: 0 });
      return {
        stdout: bytesToBinaryString(bytes),
        stderr: "",
        exitCode: 0,
        stdoutEncoding: "binary" as const,
      };
    } catch (error) {
      commandCallsResult.push({ command: bash.command, output: "", exitCode: 1 });
      return {
        stdout: "",
        stderr: ensureTrailingNewline(error instanceof Error ? error.message : String(error)),
        exitCode: 1,
      };
    }
  });
};

const createTelegramBashCommands = (input: BashCommandFactoryInput) => {
  const telegramContext = input.context.telegram;
  if (!telegramContext) {
    return [];
  }

  return [
    ...createBackofficeBashCommands({
      tools: telegramGenericBashRuntimeTools,
      context: {
        runtimes: {
          telegram: telegramContext.runtime,
        },
      },
      commandCallsResult: input.commandCallsResult,
    }),
    createTelegramDownloadCommand(telegramContext, input.commandCallsResult),
  ];
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
    runtime: createRouteBackedAutomationsRuntime({ env, orgId }),
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

export type AutomationExecutionContext = BashHostContext & {
  automation: NonNullable<BashHostContext["automation"]>;
};

export const executeBashAutomation = async ({
  script,
  context,
  masterFs,
}: {
  script: string;
  context: AutomationExecutionContext;
  masterFs: MasterFileSystem;
}): Promise<AutomationRunResult<"bash">> => {
  const eventJson = JSON.stringify(context.automation.event);
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    eventJson,
    includeDevMount: true,
  });

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

  return createAutomationRunResult({
    runtime: "bash",
    eventId: context.automation.event.id,
    scriptId: context.automation.binding.scriptId,
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    commandCalls: commandCallsResult,
  });
};

export const executeAutomationScript = async ({
  engine,
  script,
  context,
  masterFs,
  env,
}: {
  engine: AutomationScriptEngine;
  script: string;
  context: AutomationExecutionContext;
  masterFs: MasterFileSystem;
  env?: CloudflareEnv;
}) => {
  switch (engine) {
    case "bash":
      return executeBashAutomation({ script, context, masterFs });
    case "codemode": {
      if (!env?.LOADER) {
        throw new Error("Codemode automation requires the Cloudflare Worker Loader.");
      }

      const { executeCodemodeAutomation } = await import("@/fragno/automation/engine/codemode");
      return executeCodemodeAutomation({ script, context, masterFs, env });
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

const inferInteractiveScriptRunEngine = (scriptPath: string): AutomationScriptEngine =>
  scriptPath.endsWith(".cm.js") ? "codemode" : "bash";

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
}): AutomationExecutionContext => ({
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
        "scripts.run requires a MasterFileSystem but received a different filesystem type.",
      );
    }

    return executeAutomationScript({
      engine: inferInteractiveScriptRunEngine(absoluteScriptPath),
      script: scriptBody,
      context,
      masterFs: fileSystem,
      env: options.env,
    });
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
