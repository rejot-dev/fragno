import type { AutomationCommandOptionSpec } from "@/fragno/runtime-tools/automation-types";
import { STANDARD_COMMAND_OPTIONS } from "@/fragno/runtime-tools/bash-cli";
import {
  createRuntimeToolReferenceContext,
  createRuntimeToolReferences,
} from "@/fragno/runtime-tools/reference";
import { BACKOFFICE_TERMINAL_SHELL_COMMAND_SPECS } from "@/fragno/runtime-tools/terminal-shell-command-specs";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

function appendStandardCommandOptions(options: readonly AutomationCommandOptionSpec[]) {
  const optionNames = new Set(options.map((option) => option.name));
  return [
    ...options,
    ...STANDARD_COMMAND_OPTIONS.filter((option) => !optionNames.has(option.name)),
  ];
}

/** Generates client-safe terminal metadata without shipping executable runtime tools to the app. */
export function generateBackofficeTerminalCommandSpecJson(): string {
  const references = createRuntimeToolReferences({
    families: runtimeToolFamilies,
    context: createRuntimeToolReferenceContext(),
  });
  const commandSpecs = [
    ...BACKOFFICE_TERMINAL_SHELL_COMMAND_SPECS,
    ...references.flatMap((reference) => {
      if (!reference.bash) {
        return [];
      }

      return [
        {
          command: reference.bash.command,
          summary: reference.bash.summary,
          options: appendStandardCommandOptions(reference.bash.options),
        },
      ];
    }),
  ].map(({ command, summary, options }) => ({ command, summary, options }));

  return `${JSON.stringify(commandSpecs, null, 2)}\n`;
}
