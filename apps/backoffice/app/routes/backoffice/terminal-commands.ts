import type { AutomationCommandOptionSpec } from "@/fragno/runtime-tools/automation-types";
import { STANDARD_COMMAND_OPTIONS } from "@/fragno/runtime-tools/bash-cli";
import {
  createRuntimeToolReferenceContext,
  createRuntimeToolReferences,
  renderDashboardCommandGroups,
} from "@/fragno/runtime-tools/reference";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

const BACKOFFICE_TERMINAL_COMMAND_REFERENCES = createRuntimeToolReferences({
  families: runtimeToolFamilies,
  context: createRuntimeToolReferenceContext(),
});
const BACKOFFICE_TERMINAL_VISIBLE_COMMAND_REFERENCES = createRuntimeToolReferences({
  families: runtimeToolFamilies.filter((family) => !family.hidden),
  context: createRuntimeToolReferenceContext(),
});
export const BACKOFFICE_TERMINAL_COMMAND_GROUPS = renderDashboardCommandGroups(
  BACKOFFICE_TERMINAL_VISIBLE_COMMAND_REFERENCES,
);
const BACKOFFICE_TERMINAL_SHELL_COMMAND_SPECS = [
  { command: "cat", summary: "Print file contents.", options: [] },
  { command: "cd", summary: "Change the terminal working directory.", options: [] },
  { command: "find", summary: "Search for files under a directory.", options: [] },
  { command: "ls", summary: "List files and directories.", options: [] },
  { command: "pwd", summary: "Print the terminal working directory.", options: [] },
] as const;
const appendStandardCommandOptions = (options: readonly AutomationCommandOptionSpec[]) => {
  const optionNames = new Set(options.map((option) => option.name));
  return [
    ...options,
    ...STANDARD_COMMAND_OPTIONS.filter((option) => !optionNames.has(option.name)),
  ];
};

export const BACKOFFICE_TERMINAL_COMMAND_SPECS = [
  ...BACKOFFICE_TERMINAL_SHELL_COMMAND_SPECS,
  ...BACKOFFICE_TERMINAL_COMMAND_REFERENCES.flatMap((reference) => {
    if (!reference.bash) {
      return [];
    }

    return [
      {
        ...reference.bash,
        options: appendStandardCommandOptions(reference.bash.options),
      },
    ];
  }),
];
