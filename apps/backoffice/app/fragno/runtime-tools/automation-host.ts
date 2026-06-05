import type { IFileSystem } from "@/files/interface";
import { MasterFileSystem } from "@/files/master-file-system";
import {
  AUTOMATION_WORKSPACE_ROOT,
  resolveAutomationFileSystem,
  type AutomationFileSystemConfig,
  type AutomationScriptEngine,
} from "@/fragno/automation/catalog";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { createAutomationExecutionFileSystem } from "@/fragno/automation/engine/execution-file-system";
import {
  createRouteBackedAutomationsRuntime,
  createRouteBackedWorkflowsRuntime,
} from "@/fragno/automation/identity-runtime";
import {
  createAutomationRunResult,
  type AutomationRunResult,
} from "@/fragno/automation/run-result";
import type { ScriptRunArgs } from "@/fragno/runtime-tools/automation-types";
import type { ScriptRunnerRuntime } from "@/fragno/runtime-tools/families/automations";

import {
  createBashHost,
  type BashHost,
  type BashHostContext,
  type InteractiveBashCommandContext,
} from "./bash-host";
import { createEventRuntime } from "./families/event-runtime";
import { createOtpRuntime } from "./families/otp-runtime";
import { createPiRouteRuntime } from "./families/pi-runtime";
import { createResendRouteRuntime } from "./families/resend-runtime";
import { createReson8RouteRuntime } from "./families/reson8-runtime";
import { createTelegramRuntime } from "./families/telegram-runtime";

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
  workflow: {
    runtime: createRouteBackedWorkflowsRuntime({ env, orgId }),
  },
  otp: {
    runtime: createOtpRuntime({ env, orgId }),
  },
  pi: {
    runtime: createPiRouteRuntime({ env, orgId }),
  },
  reson8: {
    runtime: createReson8RouteRuntime({ env, orgId }),
  },
  resend: {
    runtime: createResendRouteRuntime({ env, orgId }),
  },
  telegram: {
    runtime: createTelegramRuntime({ env, orgId }),
  },
});

// ---------------------------------------------------------------------------
// Automation execution (bash + codemode)
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
        throw new Error(
          "Codemode automation requires the Cloudflare Worker Loader. Run codemode execution tests with vitest.cloudflare.config.ts.",
        );
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
    runtime: createEventRuntime({ env, event }),
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
