import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";

import { createStaticFileCollection } from "../../file-collection/create-static-file-collection";
import { SYSTEM_AUTOMATION_CONTENT } from "./system-automations";

const SYSTEM_README = `# Backoffice System Filesystem

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
} satisfies Record<string, string | Uint8Array>;

/** Returns whether an execution may read admin-only system files. */
export function canAccessSystemFiles(execution: BackofficeExecutionContext): boolean {
  return (
    execution.scope.kind === "system" ||
    (execution.actors.initiator.scope === "internal" &&
      execution.actors.initiator.type === "system" &&
      execution.actors.principal === null)
  );
}

export const systemFileCollection = createStaticFileCollection(SYSTEM_FILE_CONTENT);
