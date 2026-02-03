/**
 * Generates the form-builder registry item JSON with inlined file contents.
 *
 * Usage: pnpx tsx apps/docs/app/components/form-builder/generate-registry.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface RegistryFile {
  path: string;
  type: "registry:component";
  content: string;
}

interface RegistryItem {
  $schema: string;
  name: string;
  type: string;
  title: string;
  description: string;
  dependencies: string[];
  registryDependencies: string[];
  files: RegistryFile[];
}

const FILES = [
  "types.ts",
  "constants.ts",
  "schema-generator.ts",
  "schema-parser.ts",
  "use-form-builder.ts",
  "field-type-selector.tsx",
  "enum-values-editor.tsx",
  "field-options.tsx",
  "field-card.tsx",
  "form-builder.tsx",
  "form-metadata.tsx",
  "index.ts",
] as const;

function readFileContent(filename: string): string {
  const filePath = join(__dirname, filename);
  return readFileSync(filePath, "utf-8");
}

function generateRegistry(): RegistryItem {
  const files: RegistryFile[] = FILES.map((filename) => ({
    path: `components/ui/form-builder/${filename}`,
    type: "registry:component",
    content: readFileContent(filename),
  }));

  return {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: "form-builder",
    type: "registry:component",
    title: "Form Builder",
    description:
      "A visual form builder that generates JSON Schema and JSONForms UI Schema. Build forms with support for text, number, email, boolean, date, time, datetime, and dropdown fields.",
    dependencies: ["lucide-react"],
    registryDependencies: [
      "button",
      "card",
      "input",
      "label",
      "select",
      "switch",
      "tooltip",
      "dropdown-menu",
    ],
    files,
  };
}

const registry = generateRegistry();
const outputPath = join(__dirname, "form-builder.json");
writeFileSync(outputPath, JSON.stringify(registry, null, 2) + "\n");

console.log(`Generated registry item at: ${outputPath}`);
console.log(`Included ${registry.files.length} files`);
