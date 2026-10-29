import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BACKOFFICE_DEV_SERVER_SECTION = "backoffice-dev-server";

/** Tells the agent which local origin this worktree's Backoffice dev server and preview use. */
export default function registerBackofficeDevServerExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    let port: number;
    try {
      port = backofficeDevServerPort(ctx.cwd);
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
  });
}
