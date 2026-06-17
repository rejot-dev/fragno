import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { IFileSystem } from "@/files/interface";
import { MasterFileSystem } from "@/files/master-file-system";
import type { AutomationScriptEngine } from "@/fragno/automation/catalog";
import type { AutomationEventActor } from "@/fragno/automation/contracts";
import { createAutomationExecutionFileSystem } from "@/fragno/automation/engine/execution-file-system";
import {
  createAutomationRunResult,
  type AutomationRunResult,
} from "@/fragno/automation/run-result";

import { createBashHost, type BashHost, type BashHostContext } from "./bash-host";
import { createRouteBackedRuntimeContext } from "./route-backed-runtime-context";

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
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    contextFiles: { "event.json": JSON.stringify(context.automation.event) },
    includeDevMount: true,
  });

  const { bash, commandCallsResult } = createBashHost({
    fs: executionFs,
    env: {},
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
// Interactive bash host (dashboard / Pi sessions)
// ---------------------------------------------------------------------------

export type CreateInteractiveBashHostInput = {
  fs: IFileSystem;
  env: CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  orgId: string;
  sessionId?: string;
  defaultActor?: AutomationEventActor | null;
  context?: BashHostContext;
  includeDevMount?: boolean;
};

export const createInteractiveBashHost = (input: CreateInteractiveBashHostInput): BashHost => {
  const context =
    input.context ??
    (input.runtime
      ? createRouteBackedRuntimeContext({
          runtime: input.runtime,
          orgId: input.orgId,
          defaultActor: input.defaultActor,
        })
      : null);
  if (!context) {
    throw new Error("Interactive bash host requires a runtime context or runtime services.");
  }

  const fs =
    input.includeDevMount && input.fs instanceof MasterFileSystem
      ? createAutomationExecutionFileSystem({ masterFs: input.fs, includeDevMount: true })
      : input.fs;

  return createBashHost({
    fs,
    sessionId: input.sessionId,
    context,
  });
};
