---
name: backoffice-cli
description:
  Run programs, shell commands, and file operations in a live Backoffice scope with the `backoffice`
  CLI. Use when developing Backoffice and trying a change on the local dev server (codemode, `state`
  providers, workflows, `/static` skills), or when inspecting or changing a scope's files, programs,
  or Automations stream, locally or on Leyway Cloud.
---

# Operate on a Backoffice scope

The CLI acts on a running Backoffice server as the signed-in user. Run it from anywhere in the
repository as `pnpm -w -s backoffice <command>`: `-w` takes the script from the repository root,
which a package's own directory lacks. `pnpm -w -s backoffice --help` documents every command and
flag. It always runs from the repository root, so give local paths relative to the root or absolute.

## Connect

1. Choose the server. The CLI prefers this worktree's dev server and falls back to another
   worktree's, which runs different code; when trying a change, check that
   `pnpm -w -s backoffice probe` prints this worktree's server, and start it if it is down. Add
   `--base-url https://leyway.com` for Leyway Cloud.
2. Run `pnpm -w -s backoffice scopes` and take the scope argument the user means, asking when
   several fit. Every later command takes it as its first argument.
3. When a command reports no stored credential, sign in. `login` blocks until the user approves, so
   start it in the background: `pnpm -w -s backoffice login > /tmp/backoffice-login.log 2>&1 &`.
   Give the user the URL from the log and continue once the log says `Authenticated as`.

Cloud scopes hold real people's data: confirm with the user before any command that writes to one.

## Work in the scope

Before writing a program, read the scope's guidance with `pnpm -w -s backoffice system <scope>`. It
is the system prompt of Backoffice's own agent and documents the `state` API, the two codemode forms
(`async () => {}` and `defineWorkflow`), and the product skills under `/static/skills`. Read it as a
reference for the runtime; where it says `codemode`, run `backoffice exec`.

- **Programs**: pass the code on stdin through a quoted heredoc, so the shell leaves the JavaScript
  untouched. Everything the program returns lands in your context, so return a string or a small
  projection.

  ```bash
  pnpm -w -s backoffice exec <scope> - <<'EOF'
  async () => (await state.readFile({ path: "/static/SYSTEM.md" })).slice(0, 2000)
  EOF
  ```

- **Quick looks**: `pnpm -w -s backoffice bash <scope> 'grep -rn invoice /workspace | head'` runs a
  shell over the same filesystem.
- **Transfers**: `upload` writes only under `/workspace`; `download` also reads `/static`.
