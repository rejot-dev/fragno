import type { FileSystemArtifact } from "../types";
import { SYSTEM_AUTOMATION_CONTENT } from "./system-automations";

export const SYSTEM_README = `# Backoffice System Filesystem

This is the admin-only system-scope filesystem.

- Product-owned reference files live in \`/static\`.
- System-scoped admin automations live in \`/system/automations\`.
- User/org/project editable files live in \`/workspace\` for the selected scope.

Files in this mount are intended for system-scope execution. Do not put broadly visible skills,
guidance, or codemode declarations here; those belong in \`/static\`.
`;

export const SYSTEM_FILE_CONTENT = {
  "README.md": SYSTEM_README,
  ...SYSTEM_AUTOMATION_CONTENT,
} satisfies Record<string, FileSystemArtifact>;
