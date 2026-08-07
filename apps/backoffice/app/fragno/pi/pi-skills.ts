import type { PiSkillDefinition, PiSkillRegistry } from "@fragno-dev/pi-harness/skills";

import type { MasterFileSystem } from "@/files";
import { FileSystemError } from "@/files/fs-errors";
import { parseFrontmatter } from "@/lib/frontmatter";

type SkillFrontmatter = { name: string; description: string } & Record<string, unknown>;

const joinSkillPath = (root: string, name: string) => `${root.replace(/\/+$/, "")}/${name}`;

const parseFilesystemSkill = (path: string, content: string): PiSkillDefinition => {
  const parsed = parseFrontmatter<SkillFrontmatter>(content);
  if (!parsed.ok) {
    throw parsed.error;
  }

  const { frontmatter, body } = parsed.value;
  if (typeof frontmatter.name !== "string") {
    throw new Error(`Skill ${path} is missing string frontmatter field 'name'.`);
  }
  if (typeof frontmatter.description !== "string") {
    throw new Error(`Skill ${path} is missing string frontmatter field 'description'.`);
  }

  const directory = path.slice(0, path.lastIndexOf("/"));
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    body,
    directory,
    location: path,
  };
};

export const loadBackofficePiSkills = async (
  fs: MasterFileSystem,
  options: { root?: string; roots?: readonly string[] } = {},
): Promise<PiSkillRegistry> => {
  const roots =
    options.roots ?? (options.root ? [options.root] : ["/static/skills", "/workspace/skills"]);
  const skills: PiSkillRegistry = {};

  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdirWithFileTypes(root);
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }
      const directory = joinSkillPath(root, entry.name);
      const location = `${directory}/SKILL.md`;
      try {
        const content = await fs.readFile(location, { encoding: "utf-8" });
        const skill = parseFilesystemSkill(location, content);
        skills[skill.name] = skill;
      } catch (error) {
        if (error instanceof FileSystemError && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }
  }

  return skills;
};
