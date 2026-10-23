import type { Invitation } from "../../workers/directory/directory";

/** What an invitation is to, such as "the accounting firm Lovelace & Co". */
export function invitedTo({ kind, name }: Invitation["organization"]): string {
  if (kind === "operator") {
    return `${name}, the team that runs Bookkeeping`;
  }
  return kind === "firm" ? `the accounting firm ${name}` : `the books of ${name}`;
}
