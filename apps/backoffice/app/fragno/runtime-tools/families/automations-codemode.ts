import { z } from "zod";

import { automationRunResultSchema } from "@/fragno/automation/run-result";
import type { ScriptRunArgs, ScriptRunnerRuntime } from "@/fragno/runtime-tools/automation-types";
import {
  assertNoPositionals,
  parseCliTokens,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";

export type AutomationScriptRuntime = ScriptRunnerRuntime;
export type { ScriptRunnerRuntime };

export type AutomationScriptToolContext = BackofficeToolContext<{}, AutomationScriptRuntime>;

const nonEmptyString = z.string().trim().min(1);

const defineAutomationScriptTool = <
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, AutomationScriptToolContext>,
) => defineBackofficeRuntimeTool(tool);

const parseScriptRunArgs = (args: string[]): ScriptRunArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "scripts.run");
  return {
    script: readStringOption(parsed, "script", true)!,
    event: readStringOption(parsed, "event", true)!,
  };
};

const getAutomationScriptRuntime = (
  scriptRunner: AutomationScriptToolContext["scriptRunner"],
): AutomationScriptRuntime => {
  if (!scriptRunner) {
    throw new Error(
      "automations-codemode script runtime is not available in this execution context",
    );
  }
  return scriptRunner;
};

const scriptRunTool = defineAutomationScriptTool({
  id: "scripts.run",
  namespace: "automations",
  name: "runScript",
  description: "Execute an automation script against an event fixture for manual testing.",
  inputSchema: z.object({ script: nonEmptyString, event: nonEmptyString }),
  outputSchema: automationRunResultSchema,
  execute: async (input, context) =>
    await getAutomationScriptRuntime(context.scriptRunner).runScript(input),
  adapters: {
    bash: {
      command: "scripts.run",
      help: {
        summary:
          "scripts.run executes a bash or codemode automation script against an event fixture from an interactive shell context for manual testing.",
        options: [
          {
            name: "script",
            required: true,
            valueRequired: true,
            valueName: "path",
            description:
              "Path to the script file. Relative paths resolve under /workspace/automations/; absolute paths resolve against the master filesystem. *.js files run through codemode; *.sh files run through bash.",
          },
          {
            name: "event",
            required: true,
            valueRequired: true,
            valueName: "path",
            description:
              "Path to an event JSON file (e.g. /events/2026-03-25/...json). The current interactive orgId is injected when the fixture omits orgId; mismatches are rejected.",
          },
        ],
        examples: [
          "scripts.run --script router.js --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json",
          "scripts.run --script /workspace/automations/router.js --event /events/2026-03-25/2026-03-25T10:00:00.000Z_hook-id.json --format json",
        ],
      },
      parse: parseScriptRunArgs,
      format: (result, options) => {
        const hasExplicitFormat = options.format === "json" || !!options.print;
        const data = {
          runtime: result.runtime,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          logs: result.logs,
          ...(result.result !== undefined ? { result: result.result } : {}),
          ...(result.workflowDefinition !== undefined
            ? { workflowDefinition: result.workflowDefinition }
            : {}),
          commandCalls: result.commandCalls,
          toolCalls: result.toolCalls,
        };

        if (result.exitCode !== 0) {
          return {
            data,
            ...(!hasExplicitFormat ? { stdout: result.stdout } : {}),
            stderr: result.stderr || `Script exited with code ${result.exitCode}`,
            exitCode: result.exitCode,
          };
        }

        return { data, ...(!hasExplicitFormat ? { stdout: result.stdout } : {}) };
      },
    },
  },
});

export const automationScriptRuntimeTools = [scriptRunTool] as const;

export const automationScriptToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "automations-codemode",
  tools: automationScriptRuntimeTools,
  isAvailable: (context: AutomationScriptToolContext) => !!context.scriptRunner,
});
