import { createCodemodeStaticTypeFiles } from "@/fragno/codemode/codemode-type-files";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import { generateBackofficeTerminalCommandSpecJson } from "@/routes/backoffice/terminal-command-spec-generation";

/** Generates static files derived from the canonical Backoffice runtime tool catalog. */
export function generateBackofficeRuntimeToolStaticFiles() {
  return [
    ...createCodemodeStaticTypeFiles({ families: runtimeToolFamilies }),
    {
      path: "/static/terminal/terminal-spec.json",
      content: generateBackofficeTerminalCommandSpecJson(),
    },
  ];
}
