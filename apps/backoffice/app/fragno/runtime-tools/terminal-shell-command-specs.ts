import { CURRENT_SCOPE_BASH_COMMAND_SPEC } from "./current-scope-command";
import { ISOMORPHIC_GIT_BASH_COMMAND_SPECS } from "./isomorphic-git-command-spec";

/** Client-safe metadata for commands supplied directly by the Backoffice terminal shell. */
export const BACKOFFICE_TERMINAL_SHELL_COMMAND_SPECS = [
  { command: "cat", summary: "Print file contents.", options: [] },
  { command: "cd", summary: "Change the terminal working directory.", options: [] },
  { command: "find", summary: "Search for files under a directory.", options: [] },
  { command: "ls", summary: "List files and directories.", options: [] },
  { command: "pwd", summary: "Print the terminal working directory.", options: [] },
  CURRENT_SCOPE_BASH_COMMAND_SPEC,
  ...ISOMORPHIC_GIT_BASH_COMMAND_SPECS,
] as const;
