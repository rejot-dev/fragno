import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const skillNames = ["fragno", "fragno-author"] as const;

type SkillName = (typeof skillNames)[number];

type SkillIndexEntry = {
  name: string;
  description: string;
  files: string[];
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const sourceRoot = path.join(repoRoot, ".agents", "skills");
const targetRoot = path.join(repoRoot, "apps", "docs", "public", ".well-known", "skills");

function toPosix(filePath: string) {
  return filePath.split(path.sep).join("/");
}

function assertAscii(value: string, label: string) {
  for (const char of value) {
    if (char.charCodeAt(0) > 127) {
      throw new Error(`${label} contains non-ASCII characters: ${value}`);
    }
  }
}

function validateRelativePath(relPath: string) {
  if (relPath.startsWith("/")) {
    throw new Error(`Relative path must not start with '/': ${relPath}`);
  }
  if (relPath.includes("\\")) {
    throw new Error(`Relative path must use forward slashes: ${relPath}`);
  }
  if (relPath.split("/").includes("..")) {
    throw new Error(`Relative path must not include '..': ${relPath}`);
  }
  assertAscii(relPath, "files[] entry");
}

function validateSkillName(name: string) {
  const validName = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  if (!validName.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

async function collectFiles(dir: string, baseDir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, baseDir)));
    } else if (entry.isFile()) {
      const rel = toPosix(path.relative(baseDir, fullPath));
      validateRelativePath(rel);
      files.push(rel);
    }
  }

  return files;
}

async function loadSkillMetadata(skillDir: string) {
  const skillPath = path.join(skillDir, "SKILL.md");
  const contents = await fs.readFile(skillPath, "utf8");
  const parsed = matter(contents);
  const name = String(parsed.data.name ?? "").trim();
  const description = String(parsed.data.description ?? "").trim();

  if (!name) {
    throw new Error(`Missing frontmatter name in ${skillPath}`);
  }
  if (!description) {
    throw new Error(`Missing frontmatter description in ${skillPath}`);
  }
  assertAscii(name, "skill name");
  assertAscii(description, "skill description");
  validateSkillName(name);

  return { name, description };
}

async function syncSkill(skillName: SkillName): Promise<SkillIndexEntry> {
  const sourceDir = path.join(sourceRoot, skillName);
  const targetDir = path.join(targetRoot, skillName);

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });

  const { name, description } = await loadSkillMetadata(sourceDir);
  if (name !== skillName) {
    throw new Error(`Skill name mismatch for ${skillName}: frontmatter has ${name}`);
  }
  const files = await collectFiles(sourceDir, sourceDir);

  const skillFirstIndex = files.indexOf("SKILL.md");
  if (skillFirstIndex === -1) {
    throw new Error(`SKILL.md not found for ${skillName}`);
  }

  const orderedFiles = ["SKILL.md", ...files.filter((file) => file !== "SKILL.md").sort()];

  return { name, description, files: orderedFiles };
}

async function main() {
  const skills: SkillIndexEntry[] = [];
  for (const skillName of skillNames) {
    skills.push(await syncSkill(skillName));
  }

  const index = { skills };
  const indexPath = path.join(targetRoot, "index.json");
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  console.log(`Synced ${skills.length} skills to ${targetRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
