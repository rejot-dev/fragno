import type { defineCommand } from "just-bash";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import type { AutomationCommandHelp } from "./automation-types";
import {
  buildCommandHelp,
  defineCliArgsParser,
  ensureTrailingNewline,
  formatCommandStdout,
  hasHelpOption,
  parseCliTokens,
  readOutputOptions,
  STANDARD_COMMAND_OPTIONS,
} from "./bash-cli";

type DefineBashCommand = typeof defineCommand;

/** Bash command that prints the exact scope governing the current execution. */
export const CURRENT_SCOPE_BASH_COMMAND = "context.current";

/** Shared help metadata for the current scope Bash command and terminal autocomplete. */
export const CURRENT_SCOPE_BASH_COMMAND_HELP = {
  summary: "Print the exact scope governing the current execution.",
  options: [],
  examples: ["context.current", "context.current --format json", "context.current --print org-id"],
} as const satisfies AutomationCommandHelp;

/** Client-safe command metadata used by terminal help and autocomplete. */
export const CURRENT_SCOPE_BASH_COMMAND_SPEC = {
  command: CURRENT_SCOPE_BASH_COMMAND,
  ...CURRENT_SCOPE_BASH_COMMAND_HELP,
  options: STANDARD_COMMAND_OPTIONS,
};

function parseCurrentScopeCommandArgs(args: string[]): Record<string, never> {
  return defineCliArgsParser<Record<string, never>>(CURRENT_SCOPE_BASH_COMMAND, {})(args);
}

function formatCurrentScopeText(scope: BackofficeContextScope): string {
  switch (scope.kind) {
    case "system":
      return "kind  system\n";
    case "org":
      return `kind   org\norgId  ${scope.orgId}\n`;
    case "user":
      return `kind    user\nuserId  ${scope.userId}\n`;
    case "project":
      return `kind       project\norgId      ${scope.orgId}\nprojectId  ${scope.projectId}\n`;
  }

  throw new Error("context.current received an unsupported Backoffice scope kind.");
}

/** Creates the Bash command that exposes trusted current execution scope metadata. */
export function createCurrentScopeBashCommand(
  scope: BackofficeContextScope,
  defineBashCommand: DefineBashCommand,
) {
  return defineBashCommand(
    CURRENT_SCOPE_BASH_COMMAND,
    async function executeCurrentScopeBashCommand(args) {
      const parsed = parseCliTokens(args);
      if (hasHelpOption(parsed)) {
        return {
          stdout: buildCommandHelp({
            name: CURRENT_SCOPE_BASH_COMMAND,
            help: CURRENT_SCOPE_BASH_COMMAND_HELP,
            parse: parseCurrentScopeCommandArgs,
          }),
          stderr: "",
          exitCode: 0,
        };
      }

      try {
        parseCurrentScopeCommandArgs(args);
        const outputOptions = readOutputOptions(parsed);
        const stdout =
          outputOptions.format === "json" || outputOptions.print
            ? formatCommandStdout(outputOptions, { data: scope })
            : formatCurrentScopeText(scope);
        return { stdout, stderr: "", exitCode: 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          stdout: "",
          stderr: ensureTrailingNewline(`${CURRENT_SCOPE_BASH_COMMAND}: ${message}`),
          exitCode: 1,
        };
      }
    },
  );
}
