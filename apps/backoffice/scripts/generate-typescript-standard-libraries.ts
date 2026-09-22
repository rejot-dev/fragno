import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outputPath = fileURLToPath(
  new URL("../workers/compiler/typescript-standard-library.generated.json", import.meta.url),
);
const typeScriptLibraryDirectory = path.dirname(
  fileURLToPath(import.meta.resolve("typescript-runtime")),
);
const rootLibraryFiles = ["lib.es2024.d.ts", "lib.webworker.d.ts"];
const referencePattern = /<reference\s+(?:lib|path)="([^"]+)"/gu;

function referencedLibraryFile(reference: string) {
  if (reference.endsWith(".d.ts")) {
    return path.basename(reference);
  }
  return `lib.${reference}.d.ts`;
}

function collectTypeScriptStandardLibraryFiles() {
  const availableFiles = new Set(
    readdirSync(typeScriptLibraryDirectory).filter(
      (file) => file.startsWith("lib.") && file.endsWith(".d.ts"),
    ),
  );
  const collectedFiles = new Map<string, string>();

  function collectLibraryFile(file: string) {
    if (collectedFiles.has(file)) {
      return;
    }
    if (!availableFiles.has(file)) {
      throw new Error(`Missing TypeScript standard library declaration '${file}'.`);
    }
    const content = readFileSync(path.join(typeScriptLibraryDirectory, file), "utf8");
    collectedFiles.set(file, content);
    for (const match of content.matchAll(referencePattern)) {
      collectLibraryFile(referencedLibraryFile(match[1]));
    }
  }

  for (const rootLibraryFile of rootLibraryFiles) {
    collectLibraryFile(rootLibraryFile);
  }

  return Object.fromEntries(
    [...collectedFiles].sort(([left], [right]) => left.localeCompare(right)),
  );
}

const generatedContent = `${JSON.stringify(collectTypeScriptStandardLibraryFiles(), null, 2)}\n`;
const checkOnly = process.argv.includes("--check");
if (checkOnly) {
  const currentContent = readFileSync(outputPath, "utf8");
  if (currentContent !== generatedContent) {
    throw new Error(
      "TypeScript standard library pack is stale. Run pnpm --dir apps/backoffice compiler:generate.",
    );
  }
} else {
  writeFileSync(outputPath, generatedContent);
}
