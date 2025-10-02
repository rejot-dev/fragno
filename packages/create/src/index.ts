import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copy, merge } from "./utils.ts";
import { buildToolPkg } from "./package-json.ts";

type TemplateTypes = "fragment";
// TODO: the others
export type BuildTools = "esbuild" | "tsdown" | "none";

interface CreateOptions {
  path: string;
  buildTool: BuildTools;
  name: string;
  template: TemplateTypes;
}

export function create(options: CreateOptions) {
  let pkgOverride: Record<string, unknown> = { name: options.name };

  // Build tool pkg overrides
  pkgOverride = merge(pkgOverride, buildToolPkg[options.buildTool]);

  if (options.template == "fragment") {
    writeFragmentTemplate(options.path, pkgOverride);
  } else {
    throw new Error(`Unsupported template type: ${options.template}`);
  }

  switch (options.buildTool) {
    case "esbuild":
      writeOptionalTemplate(options.path, "builder/esbuild.config.js");
      break;
    case "tsdown":
      writeOptionalTemplate(options.path, "builder/tsdown.config.ts");
      break;
    case "none":
      break;
  }
}

function getTemplateDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "..", "templates");
}

function writeOptionalTemplate(targetPath: string, template: string) {
  const templatePath = path.join(getTemplateDir(), "optional", template);
  const targetFile = path.join(targetPath, path.basename(template));

  copy(templatePath, targetFile);
}

function writeFragmentTemplate(targetPath: string, pkgOverrides: Record<string, unknown>) {
  const templateDir = path.join(getTemplateDir(), "fragment");

  // Copy template files
  copy(templateDir, targetPath, (basename) => {
    if (basename === "package.template.json") {
      return "package.json";
    }
    return basename;
  });

  // Update package.json based on chosen options
  const packageJsonPath = path.join(targetPath, "package.json");
  const basePkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const newPkg = merge(basePkg, pkgOverrides);

  // Write to disk
  fs.writeFileSync(packageJsonPath, JSON.stringify(newPkg, null, 2) + "\n");
}
