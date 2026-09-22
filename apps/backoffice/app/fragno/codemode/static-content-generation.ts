import { generateBackofficeUiCatalogReferenceMarkdown } from "@/backoffice-ui/component-reference-generation";
import { createCodemodeStaticTypeFiles } from "@/fragno/codemode/codemode-type-files";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import { generateBackofficeTerminalCommandSpecJson } from "@/routes/backoffice/terminal-command-spec-generation";

/** Generates checked-in static files from their canonical runtime definitions. */
export function generateBackofficeStaticFiles() {
  return [
    ...createCodemodeStaticTypeFiles({ families: runtimeToolFamilies }),
    {
      path: "/static/terminal/terminal-spec.json",
      content: generateBackofficeTerminalCommandSpecJson(),
    },
    {
      path: "/static/skills/generating-backoffice-uis/CATALOG.md",
      content: generateBackofficeUiCatalogReferenceMarkdown(),
    },
  ];
}
