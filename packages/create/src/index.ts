import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copy } from "./utils.ts";

type TemplateTypes = "fragment";

interface FragmentTemplateOptions {
  packageName: string;
}

interface CreateOptions {
  path: string;
  template: TemplateTypes;
  config: FragmentTemplateOptions;
}

export function create(options: CreateOptions) {
  if (options.template == "fragment") {
    writeFragmentTemplate(options.path, options.config);
  }
}

function writeFragmentTemplate(targetPath: string, options: FragmentTemplateOptions) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const templateDir = path.join(__dirname, "..", "templates", "fragment");

  console.log("Copying from", templateDir, "to", targetPath);
  // Copy template files, renaming package.template.json to package.json
  copy(templateDir, targetPath, (basename) => {
    if (basename === "package.template.json") {
      return "package.json";
    }
    return basename;
  });

  // Modify package.json to set the actual package name
  const packageJsonPath = path.join(targetPath, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  packageJson.name = options.packageName;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
}
