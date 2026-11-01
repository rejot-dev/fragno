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
      `In this worktree, Backoffice's \`pnpm dev\` and \`pnpm preview\` (apps/backoffice) listen on ` +
      `http://127.0.0.1:${port}. The port is fixed: if it is taken, a Backoffice server from this ` +
      `worktree is probably already running, so probe it instead of starting another one. ` +
      `If you start the server yourself (including after killing one), stop it when you are done. ` +
      `To sign in, use the dev account \`${process.env["USER"] ?? "$USER"}@rejot.dev\` with password ` +
      `\`wachtwoord\`. If it does not exist yet, create it with ` +
      `\`pnpm --filter @fragno-apps/backoffice-rr dev-account:create\` while the server runs.`;

    // Only the session naming goes into the prompt, not the live sessions or ports: those change
    // during a run, and every change to a section adds a prompt delta.
    if (!hasWorktreeTmuxSession(ctx.cwd, worktreeName)) {
      return;
    }
    event.systemPromptOptions.sections[TMUX_SECTION] =
      `The user works on this worktree in tmux sessions named \`${worktreeName}-<n>\`, and may run ` +
      `servers such as Backoffice in them. \`scripts/tmux-ports.sh\` lists every tmux pane with ` +
      `the ports it listens on; use it to find the pane that runs a server, then read that ` +
      `server's output with \`tmux capture-pane -p -t <pane> -S -200\`. Never kill, restart, or ` +
      `send keys to a pane you did not start. Start long-running processes (dev servers, ` +
      `watchers) in a new detached session, so the user can attach to it: ` +
      `\`tmux new-session -d -s ${worktreeName}-<n> -c <dir>\`, then ` +
      `\`tmux send-keys -t ${worktreeName}-<n> '<command>' Enter\`, with \`<n>\` the lowest ` +
      `number no session uses yet. Sending the command to the session's shell keeps its output ` +
      `readable after it exits. Read its output the same way, and kill the session with ` +
      `\`tmux kill-session -t ${worktreeName}-<n>\` when you are done.`;
  });
}
