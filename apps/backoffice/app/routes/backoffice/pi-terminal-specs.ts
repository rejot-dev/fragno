/*
 * Pi terminal command specs — the catalogue of bash commands the terminal knows
 * about, used for autocomplete, argument hints, and the command reference. Pure
 * data, client-safe: this is imported by both the backoffice dashboard and the
 * Cadence dev console, so it must not pull in any server-only modules.
 */

import type { AutomationCommandOptionSpec } from "@/fragno/runtime-tools/automation-types";
import { STANDARD_COMMAND_OPTIONS } from "@/fragno/runtime-tools/bash-cli";
import {
  createRuntimeToolReferenceContext,
  createRuntimeToolReferences,
  renderDashboardCommandGroups,
  type RuntimeToolReference,
} from "@/fragno/runtime-tools/reference";
import type { BackofficeToolContext } from "@/fragno/runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import type { DashboardCommandSpec } from "./dashboard-terminal";

const COMMAND_REFERENCES = createRuntimeToolReferences({
  families: runtimeToolFamilies,
  context: createRuntimeToolReferenceContext(),
});

const VISIBLE_COMMAND_REFERENCES = createRuntimeToolReferences({
  families: runtimeToolFamilies.filter((family) => !family.hidden),
  context: createRuntimeToolReferenceContext(),
});

/** Grouped, human-readable command reference (rendered in the dashboard sidebar). */
export const PI_TERMINAL_COMMAND_GROUPS = renderDashboardCommandGroups(VISIBLE_COMMAND_REFERENCES);

const SHELL_COMMAND_SPECS = [
  {
    command: "automations",
    summary: "List this organisation's automations (ls over the automation roots).",
    options: [
      {
        name: "format",
        description: "Output format: text (default) or json",
        valueRequired: true,
        valueName: "format",
      },
    ],
  },
  { command: "cat", summary: "Print file contents.", options: [] },
  { command: "cd", summary: "Change the terminal working directory.", options: [] },
  { command: "find", summary: "Search for files under a directory.", options: [] },
  { command: "help", summary: "List the commands available in this terminal.", options: [] },
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

const toCommandSpec = (reference: RuntimeToolReference): DashboardCommandSpec => ({
  ...reference.bash,
  options: appendStandardCommandOptions(reference.bash.options),
});

/**
 * Bash shell builtins plus every runtime-tool command (a static superset).
 *
 * This is built with a permissive context, so it lists commands regardless of
 * whether their runtime is actually wired. That is intentional: it backs
 * client-side autocomplete, which has no access to the server runtime. For an
 * accurate, context-filtered list (used by `help`), see
 * {@link getAvailablePiTerminalCommandSpecs}.
 */
export const PI_TERMINAL_COMMAND_SPECS: DashboardCommandSpec[] = [
  ...SHELL_COMMAND_SPECS,
  ...COMMAND_REFERENCES.map(toCommandSpec),
];

/**
 * The terminal command specs that are genuinely available for a given runtime
 * context: the shell helpers plus only the runtime-tool commands whose family is
 * both visible (not hidden) and actually wired in `context`. Use this server-side
 * — where the real runtime context is known — so `help` matches what will run.
 */
export const getAvailablePiTerminalCommandSpecs = (
  context: BackofficeToolContext,
): DashboardCommandSpec[] => {
  const references = createRuntimeToolReferences({
    families: runtimeToolFamilies.filter((family) => !family.hidden),
    context,
  });
  return [...SHELL_COMMAND_SPECS, ...references.map(toCommandSpec)];
};

const firstLine = (value: string) => value.trim().split("\n")[0]?.trim() ?? "";

/** Group key for the `help` listing: the namespace before the dot, or "general". */
const helpGroupName = (command: string) =>
  command.includes(".") ? `${command.slice(0, command.indexOf("."))}.*` : "general";

/**
 * Render the curated `help` listing for the terminal: the commands we actually
 * expose (shell helpers + every runtime-tool command), grouped by namespace.
 * This replaces just-bash's builtin `help`, which lists its own internal shell
 * builtins rather than the commands available here.
 */
export const formatPiTerminalHelp = (
  specs: readonly DashboardCommandSpec[] = PI_TERMINAL_COMMAND_SPECS,
): string => {
  const width = Math.max(...specs.map((spec) => spec.command.length));
  const groups = new Map<string, DashboardCommandSpec[]>();
  for (const spec of specs) {
    const group = helpGroupName(spec.command);
    groups.set(group, [...(groups.get(group) ?? []), spec]);
  }

  const sections = [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === "general") {
        return -1;
      }
      if (right === "general") {
        return 1;
      }
      return left.localeCompare(right);
    })
    .map(([group, groupSpecs]) => {
      const lines = groupSpecs
        .slice()
        .sort((left, right) => left.command.localeCompare(right.command))
        .map((spec) => `  ${spec.command.padEnd(width)}  ${firstLine(spec.summary)}`);
      return [`${group}:`, ...lines].join("\n");
    });

  return [
    "Available commands:",
    "",
    ...sections,
    "",
    "Type '<command> --help' for details on a command.",
    "",
  ].join("\n");
};

const optionUsage = (option: AutomationCommandOptionSpec) => {
  const value = option.valueRequired ? ` <${option.valueName ?? "value"}>` : "";
  const usage = `--${option.name}${value}`;
  return option.required ? usage : `[${usage}]`;
};

/**
 * Render `help <command>` for a single known command, or null when it is not one
 * of the commands we expose (the caller falls back to a "no help" message).
 */
export const formatPiTerminalCommandHelp = (
  command: string,
  specs: readonly DashboardCommandSpec[] = PI_TERMINAL_COMMAND_SPECS,
): string | null => {
  const spec = specs.find((candidate) => candidate.command === command);
  if (!spec) {
    return null;
  }

  const usage = spec.options.map(optionUsage).join(" ");
  const optionLines = spec.options.map(
    (option) => `  --${option.name}${option.required ? " (required)" : ""}: ${option.description}`,
  );

  return [
    `${spec.command}${usage ? ` ${usage}` : ""}`,
    `  ${firstLine(spec.summary)}`,
    ...(optionLines.length ? ["", "Options:", ...optionLines] : []),
    "",
  ].join("\n");
};
