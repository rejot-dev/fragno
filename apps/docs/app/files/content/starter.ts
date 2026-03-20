import type { FileSystemArtifact } from "../types";
import { STARTER_AUTOMATION_CONTENT } from "./automations";

export const STARTER_WORKSPACE_CONTENT = {
  "README.md": `# Workspace starter pack

This workspace is the editable side of the combined Files system.

## Suggested flow

1. Capture inputs and constraints in \`input/notes.md\`.
2. Draft prompts, plans, or scratch output in the folders below.
3. Manage automation defaults in \`automations/bindings.json\` and \`automations/scripts/*.sh\`.
4. When Upload is configured, persistent files can override these starter files at the same path.

Starter files should be seeded only when missing so later runtime bootstraps do not overwrite your work.
`,
  "input/notes.md": `# Notes

Use this file for requirements, TODOs, links, and rough context before handing work to Pi or a Sandbox runtime.
`,
  "prompts/task.md": `# Task prompt

Describe the task you want to work on here.

- Goal:
- Constraints:
- Inputs:
- Expected output:
`,
  "output/.gitkeep": "",
  ...STARTER_AUTOMATION_CONTENT,
} satisfies Record<string, FileSystemArtifact>;

export const STARTER_WORKSPACE_ROOT_DESCRIPTION =
  "Starter workspace files, including filesystem-backed automation manifests and shell scripts, layered under an optional persistent Upload-backed override. Bootstrap uses if-missing semantics so starter content remains the fallback source of truth.";
