import type { FileSystemArtifact } from "../types";

export const SYSTEM_FILE_CONTENT = {
  "README.md": `# Fragno Files workspace

The Backoffice Files area shows the combined filesystem that Fragno wires into docs tooling.

## Roots

- /system — immutable, TS-owned guidance and reference files.
- /workspace — starter content layered under an optional persistent Upload-backed override.

## Why these files exist

These docs live in app code so the default filesystem has a stable explanation even before Pi or Sandbox materialization runs.
`,
  "how-it-works.md": `# How the combined filesystem works

Each root is provided by a mounted filesystem.

A mount can:

- register metadata such as \`mountPoint\`, \`readOnly\`, and \`persistence\`
- provide a sparse bootstrap tree for the Backoffice explorer
- implement filesystem-style operations such as \`readdir\`, \`stat\`, \`readFile\`, \`writeFile\`, \`mkdir\`, and \`rm\`

Backoffice uses the generic tree and detail model. Pi and Sandbox materialization consume the same mounted-filesystem contract.
`,
  "roots/system.md": `# /system

\`/system\` is the immutable documentation root.

Use it for:

- explaining what each root means
- describing mounted filesystem behavior
- giving agents and users local guidance without runtime fetches

This root is read-only by design.
`,
  "roots/workspace.md": `# /workspace

\`/workspace\` is the single user-facing editable workspace root.

Semantics:

- starter files come from TS-owned content
- starter automation defaults live under \`/workspace/automations\`
- when Upload is configured, persistent org-scoped files override starter files at the same path
- deleting a persistent override reveals the starter file again
- starter-only files remain read-only because tombstones are not supported
- when Upload is unavailable, \`/workspace\` stays browseable and readable but mutations fail clearly

Sandbox bootstrapping should still seed starter files with if-missing semantics.
`,
} satisfies Record<string, FileSystemArtifact>;

export const SYSTEM_FILE_ROOT_DESCRIPTION =
  "Immutable TS-owned guidance for the combined Files system, its roots, and mounted filesystem behavior.";
