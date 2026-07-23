import type { FileContent } from "../interface";
import { WORKSPACE_STARTER_AUTOMATION_CONTENT } from "./starter-automations";

export const WORKSPACE_STARTER_CONTENT: Record<string, FileContent> = {
  "AGENTS.md": `# Workspace guidance

This is the editable organisation workspace. User-owned automations live in \`/workspace/automations/\` and may be changed freely.

Product-owned guidance and static automations live in \`/static\` and are read-only.
`,
  "README.md": `# Workspace starter content

This editable workspace contains starter automation content and scratch areas.
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
  ...WORKSPACE_STARTER_AUTOMATION_CONTENT,
};
