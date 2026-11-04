import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BACKOFFICE_DEV_SERVER_SECTION = "backoffice-dev-server";
const TMUX_SECTION = "tmux";

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Whether tmux has a session named after the worktree, as `<worktree>` or `<worktree>-<n>`: then
 * the user works on this worktree through tmux and may run its servers there.
 */
function hasWorktreeTmuxSession(cwd: string, worktreeName: string): boolean {
  let sessions: string;
  try {
    sessions = run(cwd, "tmux", ["list-sessions", "-F", "#{session_name}"]);
  } catch {
    // tmux is not installed or no tmux server is running.
    return false;
  }
  return sessions
    .split("\n")
    .some((session) => session === worktreeName || session.startsWith(`${worktreeName}-`));
}

/**
 * Tells the agent which local origin this worktree's Backoffice dev server and preview use, and
 * how to find and start servers in the user's tmux sessions.
 */
export default function registerBackofficeDevServerExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    let port: number;
    let worktreeName: string;
    try {
      port = backofficeDevServerPort(ctx.cwd);
      worktreeName = basename(run(ctx.cwd, "git", ["rev-parse", "--show-toplevel"]).trim());
    } catch {
      // Outside a git checkout there is no worktree, so no port to report.
      return;
    }

    event.systemPromptOptions.sections[BACKOFFICE_DEV_SERVER_SECTION] =
      `Backoffice's \`pnpm dev\` and \`pnpm preview\` serve http://127.0.0.1:${port} in this ` +
      `worktree. If the port is taken, the server is likely already running; use it. Stop servers ` +
      `you start. Sign in as \`${process.env["USER"] ?? "$USER"}@rejot.dev\` / \`wachtwoord\`, ` +
      `created by \`pnpm --filter @fragno-apps/backoffice-rr dev-account:create\`.`;

    // Only the session naming goes into the prompt, not the live sessions or ports: those change
    // during a run, and every change to a section adds a prompt delta.
    if (!hasWorktreeTmuxSession(ctx.cwd, worktreeName)) {
      return;
    }
    event.systemPromptOptions.sections[TMUX_SECTION] =
      `The user runs servers in tmux sessions named \`${worktreeName}-<n>\`; ` +
      `\`scripts/tmux-ports.sh\` maps panes to ports. Stop, rebuild, and restart those servers in ` +
      `their panes as needed. ` +
      `Start new long-running processes in a detached \`${worktreeName}-<n>\` session, via ` +
      `\`send-keys\` so output survives exit, and kill it when done.`;
  });
}
