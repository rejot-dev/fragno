---
name: leyway-cli
description:
  Run programs, shell commands, and file operations in a live Backoffice scope with the `leyway`
  CLI. Use when developing Backoffice and trying a change on the local dev server (codemode, `state`
  providers, workflows, `/static` skills), or when inspecting or changing a scope's files, programs,
  or Automations stream, locally or on Leyway Cloud.
---

# Operate on a Backoffice scope

The Leyway CLI acts on a running Backoffice server as the signed-in user. Run it from anywhere in
the repository as `pnpm -w -s leyway <command>`: `-w` takes the script from the repository root,
which a package's own directory lacks. `pnpm -w -s leyway --help` documents every command and flag.
It always runs from the repository root, so give local paths relative to the root or absolute.

## Connect

1. Choose the server. The CLI prefers this worktree's dev server and falls back to another
   worktree's, which runs different code; when trying a change, check that `pnpm -w -s leyway probe`
   prints this worktree's server, and start it if it is down. Add `--base-url https://leyway.com`
   for Leyway Cloud.
2. Run `pnpm -w -s leyway scopes` and take the scope argument the user means, asking when several
   fit. Every later command takes it as its first argument.
3. When a command reports no stored credential, run `pnpm -w -s leyway login --start`. If it prints
   an approval URL, give it to the user in a progress message, then **in the same turn** run
   `pnpm -w -s leyway login --wait`. Pass the selected server's `--base-url` to both calls. Resume
   the scope command once login prints `Authenticated as`. If a tool timeout interrupts the wait,
   rerun `--wait` for the same approval; if approval expires, restart with `--start`. A denial ends
   the sign-in attempt.

Cloud scopes hold real people's data: confirm with the user before any command that writes to one.

## Work in the scope

Before writing a program, read the scope's guidance with `pnpm -w -s leyway system <scope>`. It is
the system prompt of Backoffice's own agent and documents the `state` API, the two codemode forms
(`async () => {}` and `defineWorkflow`), and the product skills under `/static/skills`. Read it as a
reference for the runtime; where it says `codemode`, run `leyway exec`.

- **Programs**: pass the code on stdin through a quoted heredoc, so the shell leaves the JavaScript
  untouched. Everything the program returns lands in your context, so return a string or a small
  projection.

  ```bash
  pnpm -w -s leyway exec <scope> - <<'EOF'
  async () => (await state.readFile({ path: "/static/SYSTEM.md" })).slice(0, 2000)
  EOF
  ```

- **Quick looks**: `pnpm -w -s leyway bash <scope> 'grep -rn invoice /workspace | head'` runs a
  shell over the same filesystem.
- **Transfers**: `upload` writes only under `/workspace`; `download` also reads `/static`.
