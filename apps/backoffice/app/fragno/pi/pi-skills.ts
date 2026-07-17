import type { PiSkillDefinition, PiSkillRegistry } from "@fragno-dev/pi-harness/skills";
import { parse } from "yaml";

import type { MasterFileSystem } from "@/files";
import { FileSystemError } from "@/files/fs-errors";

type Result<TValue, TError extends Error> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Frontmatter is parsed at a trusted file boundary and projected to the caller's schema type.
function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
): Result<{ frontmatter: T; body: string }, Error> {
  try {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---")) {
      return { ok: true, value: { frontmatter: {} as T, body: normalized } };
    }
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
      return { ok: true, value: { frontmatter: {} as T, body: normalized } };
    }
    const yamlString = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();
    return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

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
