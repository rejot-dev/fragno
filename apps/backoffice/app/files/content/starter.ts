import type { FileSystemArtifact } from "../types";
import { STARTER_AUTOMATION_CONTENT } from "./automations";

export const STATIC_STARTER_CONTENT = {
  "README.md": `# Static starter content

This read-only starter tree contains example files and default automation content.

## Suggested flow

1. Review example inputs and constraints in \`input/notes.md\`.
2. Use the files below as templates for prompts, plans, or scratch output.
3. Review automation defaults in \`automations/bindings.json\` (with absolute \`/starter/automations/...\` script paths) and scripts under \`automations/scripts/\`.
   - Use \`*.cm.js\` plus \`engine: "codemode"\` for codemode scripts.
   - Use \`*.sh\` plus \`engine: "bash"\` for bash scripts.

Copy anything you want to edit into writable workspace storage.
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

export const STATIC_STARTER_ROOT_DESCRIPTION =
  "Read-only static starter files, including filesystem-backed automation manifests plus bash/codemode scripts under /starter.";
