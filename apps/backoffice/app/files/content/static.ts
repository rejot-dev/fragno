import systemGuidanceTemplate from "../../../content/static/SYSTEM.md?raw";
import { createStaticFileCollection } from "../../file-collection/create-static-file-collection";
import type { FileCollection } from "../../file-collection/file-collection";
import { GENERAL_SKILL_CONTENT } from "./skills";
import { STATIC_AUTOMATION_CONTENT } from "./static-automations";
import { STATIC_CODEMODE_CONTENT } from "./static-codemode";

/**
 * Who reads the guidance: Leyway's own agent, which talks with people in conversations, or an agent
 * that reaches Leyway through its MCP server. Each has whole paragraphs or sections between its own
 * `<!-- audience -->` and `<!-- /audience -->` lines in the template; the formatter would join a
 * marker inside a list or paragraph into it.
 */
export type StaticGuidanceAudience = "in-app" | "mcp";

const AUDIENCE_BLOCK = /^<!-- (in-app|mcp) -->\n([\s\S]*?)^<!-- \/\1 -->\n/gmu;
// The formatter surrounds each marker with blank lines, which pile up where blocks are removed.
const EXTRA_BLANK_LINES = /\n{3,}/gu;

export const renderStaticGuidance = ({
  audience,
  codemodeDts,
  stateExcerpt,
}: {
  audience: StaticGuidanceAudience;
  codemodeDts: string;
  stateExcerpt: string;
}) =>
  // The formatter ends each placeholder with a statement semicolon that the declarations already have.
  systemGuidanceTemplate
    .replace(AUDIENCE_BLOCK, (_, blockAudience: string, block: string) =>
      blockAudience === audience ? block : "",
    )
    .replace(EXTRA_BLANK_LINES, "\n\n")
    .replace("__BACKOFFICE_CODEMODE_DTS__;", codemodeDts.trimEnd())
    .replace("__BACKOFFICE_STATE_EXCERPT__;", stateExcerpt.trimEnd());

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
