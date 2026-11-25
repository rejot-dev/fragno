import { createStaticFileCollection } from "../../file-collection/create-static-file-collection";
import type { FileCollection } from "../../file-collection/file-collection";

const SYSTEM_README = `# Backoffice System Filesystem

This is the admin-only system-scope filesystem.

- Product-owned reference files live in \`/static\`.
- User/org/project editable files live in \`/workspace\` for the selected scope.

Files in this mount are intended for system-scope execution. Do not put broadly visible skills,
guidance, or codemode declarations here; those belong in \`/static\`.
`;

export const SYSTEM_FILE_CONTENT = {
  "README.md": SYSTEM_README,
} satisfies Record<string, string | Uint8Array>;

/** Built per execution, like the static collection, so module evaluation stays cheap. */
export function createBackofficeSystemFileCollection(): FileCollection {
  return createStaticFileCollection(SYSTEM_FILE_CONTENT);
}
