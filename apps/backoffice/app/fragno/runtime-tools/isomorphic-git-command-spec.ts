import type { AutomationCommandHelp } from "./automation-types";

/** Resource bounds enforced by the Backoffice isomorphic-git clone command. */
export const ISOMORPHIC_GIT_CLONE_LIMITS = {
  defaultDepth: 1,
  maximumDepth: 50,
  defaultFileLimit: 5_000,
  maximumFileLimit: 20_000,
  defaultByteLimit: 50 * 1024 * 1024,
  maximumByteLimit: 250 * 1024 * 1024,
} as const;

/** Client-safe metadata used by terminal help and autocomplete for isomorphic-git commands. */
export const ISOMORPHIC_GIT_BASH_COMMAND_SPECS = [
  {
    command: "git.clone",
    summary: "Clone a Git repository into the terminal filesystem with resource bounds.",
    options: [
      {
        name: "help",
        description: "Show git.clone usage.",
        valueRequired: false,
      },
      {
        name: "depth",
        description: `Clone history depth; defaults to ${ISOMORPHIC_GIT_CLONE_LIMITS.defaultDepth} and cannot exceed ${ISOMORPHIC_GIT_CLONE_LIMITS.maximumDepth}.`,
        valueRequired: true,
        valueName: "number",
      },
      {
        name: "ref",
        description: "Branch or tag to clone.",
        valueRequired: true,
        valueName: "ref",
      },
      {
        name: "max-files",
        description: `Maximum files allowed in a clone; defaults to ${ISOMORPHIC_GIT_CLONE_LIMITS.defaultFileLimit} and cannot exceed ${ISOMORPHIC_GIT_CLONE_LIMITS.maximumFileLimit}.`,
        valueRequired: true,
        valueName: "number",
      },
      {
        name: "max-bytes",
        description: `Maximum bytes allowed in a clone; defaults to ${ISOMORPHIC_GIT_CLONE_LIMITS.defaultByteLimit} and cannot exceed ${ISOMORPHIC_GIT_CLONE_LIMITS.maximumByteLimit}.`,
        valueRequired: true,
        valueName: "number",
      },
    ],
    examples: ["git.clone https://github.com/example/repository.git"],
  },
  {
    command: "git.status",
    summary: "Show the Git working tree status for a terminal filesystem directory.",
    options: [
      {
        name: "help",
        description: "Show git.status usage.",
        valueRequired: false,
      },
      {
        name: "dir",
        description: "Repository directory; defaults to the current directory.",
        valueRequired: true,
        valueName: "path",
      },
    ],
    examples: ["git.status /workspace/repository"],
  },
  {
    command: "git.call",
    summary: "Call a non-network isomorphic-git function in the terminal filesystem.",
    options: [
      {
        name: "help",
        description: "Show git.call usage.",
        valueRequired: false,
      },
    ],
    examples: ["git.call log '{\"depth\":5}'"],
  },
] as const satisfies readonly ({ command: string } & AutomationCommandHelp)[];
