import systemGuidanceTemplate from "../../../content/static/SYSTEM.md?raw";
import { createStaticFileCollection } from "../../file-collection/create-static-file-collection";
import type { FileCollection } from "../../file-collection/file-collection";
import { GENERAL_SKILL_CONTENT } from "./skills";
import { STATIC_AUTOMATION_CONTENT } from "./static-automations";
import { STATIC_CODEMODE_CONTENT } from "./static-codemode";

export const renderStaticGuidance = ({ codemodeDts }: { codemodeDts: string }) =>
  systemGuidanceTemplate.replace("__BACKOFFICE_CODEMODE_DTS__", codemodeDts.trimEnd());

export const STATIC_FILE_CONTENT = {
  "SYSTEM.md": systemGuidanceTemplate,
  ...STATIC_AUTOMATION_CONTENT,
  ...GENERAL_SKILL_CONTENT,
  ...STATIC_CODEMODE_CONTENT,
} satisfies Record<string, string | Uint8Array>;

/** Product-owned files are identical for every execution. */
export function createBackofficeStaticFileCollection(): FileCollection {
  return createStaticFileCollection(STATIC_FILE_CONTENT);
}
