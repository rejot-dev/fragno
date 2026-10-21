import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const mainWorktreePort = 5173;
const linkedWorktreePortBase = 5200;
const linkedWorktreePortCount = 800;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Linked worktrees derive their port from their folder name, so a worktree keeps its local origin
 * (and the OAuth redirects and links configured for it) across restarts and never takes 5173.
 */
function linkedWorktreePort(worktreeFolderName: string): number {
  // FNV-1a
  let hash = 0x811c9dc5;
  for (const char of worktreeFolderName) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return linkedWorktreePortBase + (hash % linkedWorktreePortCount);
}

/** Port the Backoffice dev server and preview listen on in the git worktree containing `cwd`. */
export function backofficeDevServerPort(cwd: string): number {
  const [gitDir, commonDir, worktreePath] = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
    "--show-toplevel",
  ]).split("\n");
  return gitDir === commonDir ? mainWorktreePort : linkedWorktreePort(basename(worktreePath));
}

/**
 * Ports a local Backoffice may listen on, seen from `cwd`: its own worktree's port first, then
 * those of the repository's other worktrees. Outside a git repository only the main port remains.
 */
export function backofficeDevServerPorts(cwd: string): number[] {
  let ownPort: number;
  let worktreeListing: string;
  try {
    ownPort = backofficeDevServerPort(cwd);
    worktreeListing = git(cwd, ["worktree", "list", "--porcelain"]);
  } catch {
    return [mainWorktreePort];
  }

  // `git worktree list` always lists the main worktree first.
  const worktreePorts = worktreeListing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line, index) =>
      index === 0 ? mainWorktreePort : linkedWorktreePort(basename(line.slice("worktree ".length))),
    );
  return [ownPort, ...new Set(worktreePorts.filter((port) => port !== ownPort))];
}
