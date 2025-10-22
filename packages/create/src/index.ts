import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copy, merge } from "./utils.ts";
import { basePkg, buildToolPkg, databasePkg } from "./package-json.ts";
import { z } from "zod";

const templateTypesSchema = z.literal("fragment");
export type TemplateTypes = z.infer<typeof templateTypesSchema>;

const buildToolsSchema = z.enum([
  "esbuild",
  "tsdown",
  "vite",
  "rollup",
  "webpack",
  "rspack",
  "none",
]);
export type BuildTools = z.infer<typeof buildToolsSchema>;

const agentDocsSchema = z.enum(["AGENTS.md", "CLAUDE.md", "none"]);
export type AgentDocs = z.infer<typeof agentDocsSchema>;

export const createOptionsSchema = z.object({
  path: z.string(),
  buildTool: buildToolsSchema,
  name: z.string(),
  template: templateTypesSchema,
  agentDocs: agentDocsSchema,
  withDatabase: z.boolean(),
});

type CreateOptions = z.infer<typeof createOptionsSchema>;

export function create(options: CreateOptions) {
  let pkgOverride: Record<string, unknown> = merge(basePkg, { name: options.name });

  // Build tool pkg overrides
  pkgOverride = merge(pkgOverride, buildToolPkg[options.buildTool]);

  // Database pkg overrides
  if (options.withDatabase) {
    pkgOverride = merge(pkgOverride, databasePkg);
  }

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
    case "vite":
      writeOptionalTemplate(options.path, "builder/vite.config.ts");
      break;
    case "rollup":
      writeOptionalTemplate(options.path, "builder/rollup.config.js");
      break;
    case "webpack":
      writeOptionalTemplate(options.path, "builder/webpack.config.js");
      break;
    case "rspack":
      writeOptionalTemplate(options.path, "builder/rspack.config.js");
      break;
    case "none":
      break;
  }

  switch (options.agentDocs) {
    case "AGENTS.md":
      writeOptionalTemplate(options.path, "agent/AGENTS.md");
      break;
    case "CLAUDE.md":
      writeOptionalTemplate(options.path, "agent/AGENTS.md", "CLAUDE.md");
      break;
    case "none":
      break;
  }

  if (options.withDatabase) {
    writeOptionalTemplate(options.path, "database/index.ts", "src/index.ts");
    writeOptionalTemplate(options.path, "database/schema.ts", "src/schema.ts");
  }
}

function getTemplateDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "..", "templates");
}

function writeOptionalTemplate(targetPath: string, template: string, rename?: string) {
  const templatePath = path.join(getTemplateDir(), "optional", template);
  const targetFileName = rename ? rename : path.basename(template);
  const targetFile = path.join(targetPath, targetFileName);

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
