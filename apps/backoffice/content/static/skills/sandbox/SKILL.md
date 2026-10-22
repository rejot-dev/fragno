---
name: sandbox
description:
  "Sandbox isolated shell work in Backoffice-managed Cloudflare containers. Use when the task
  requires starting, listing, executing commands in, or terminating a sandbox runtime, or moving
  files between Backoffice and a sandbox."
---

# Sandbox

Treat a sandbox as a leased environment: **acquire → execute → release**. Stopping a sandbox saves
its workspace, and starting the same id again resumes it with files, installed packages, and
repositories intact. The `sandbox` provider is available only when the deployment exposes the
Sandbox capability.

## Required process

1. Check for "/static/codemode/providers/sandbox.d.ts". If it is absent, report that this deployment
   does not expose the Sandbox capability. When present, read it and list current instances:

   ```js
   async () => await sandbox.listSandboxes();
   ```

   Reuse a suitable running sandbox, resume a stopped one whose `workspaceSaved` is true, or choose
   a new id for a fresh workspace. **Complete when** the target sandbox id and lifecycle disposition
   are known.

2. Start the sandbox with a lease. `sleepAfter` saves and stops it after that long, and defaults to
   `10m`. Set `keepAlive` only when the user asks to preserve it beyond the task. For a new
   workspace, `image: "workspace"` (the default) has Node.js, Python, git, curl, tar, ripgrep, and
   jq; `image: "debian"` has only Node.js and starts fastest. A saved workspace keeps its image.
   Raise `instanceType` from `"lite"` to `"standard-1"` or larger for builds:

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

   Starting returns `requested`; list sandboxes until the status is `running` or `error`. **Complete
   when** the requested sandbox is running.

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
   failure. When the task moves files between Backoffice and the sandbox, read
   `/static/skills/sandbox/references/moving-files.md` first. **Complete when** every command
   succeeded and its expected output was checked, or a non-retryable failure was identified
   precisely.

4. Release the lease when the task no longer needs the environment. Killing saves the workspace for
   a later start of the same id:

   ```js
   async () => await sandbox.killSandbox({ sandboxId: "dev" });
   ```

   **Complete only when** the sandbox is killed, intentionally retained at the user's request, or
   left under an explicit `sleepAfter` lease.
