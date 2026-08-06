---
name: sandbox
description:
  "Sandbox isolated shell work in Backoffice-managed Cloudflare containers. Use when the task
  requires starting, listing, executing commands in, or terminating a sandbox runtime."
---

# Sandbox

Treat a sandbox as a leased environment: **acquire → execute → release**. The `sandbox` provider is
available only when the deployment exposes the Sandbox capability.

## Required process

1. Check for "/static/codemode/providers/sandbox.d.ts". If it is absent, report that this deployment
   does not expose the Sandbox capability. When present, read it and list current instances:

   ```js
   async () => await sandbox.listSandboxes({});
   ```

   Reuse a suitable running sandbox or choose a stable id for a new one. **Complete when** the
   target sandbox id and lifecycle disposition are known.

2. Start a sandbox with an idle lease. Set `keepAlive` only when the user asks to preserve it beyond
   the task:

   ```js
   async () => {
     return await sandbox.startSandbox({
       id: "dev",
       sleepAfter: "15m",
       startupCommand: "true",
       startupTimeoutMs: 30000,
     });
   };
   ```

   **Complete when** the requested sandbox exists and its returned status has been checked.

3. Execute bounded commands and inspect the discriminated result:

   ```js
   async () => {
     const result = await sandbox.executeCommand({
       sandboxId: "dev",
       command: "pwd && ls -la",
       timeoutMs: 30000,
     });
     if (!result.ok) {
       throw new Error(result.reason + ": " + result.message);
     }
     return result;
   };
   ```

   Trust command output only when `result.ok` is true. On failure, use `reason`, `retryable`,
   stdout, and stderr to decide whether to correct the command, restart the sandbox, or report the
   failure. **Complete when** every command succeeded and its expected output was checked, or a
   non-retryable failure was identified precisely.

4. Release the lease when the task no longer needs the environment:

   ```js
   async () => await sandbox.killSandbox({ sandboxId: "dev" });
   ```

   **Complete only when** the sandbox is killed, intentionally retained at the user's request, or
   left under an explicit `sleepAfter` lease.
