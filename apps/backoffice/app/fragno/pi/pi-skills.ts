import type { PiSkillDefinition, PiSkillRegistry } from "@fragno-dev/pi-harness/skills";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { parseFrontmatter } from "@/lib/frontmatter";

type SkillFrontmatter = { name: string; description: string } & Record<string, unknown>;
type PiSkillState = Pick<BackofficeStateBackend, "glob" | "readFile">;

const isUploadNotConfiguredError = (
  error: unknown,
): error is Error & { name: "UploadFileListingError"; code: "NOT_CONFIGURED" } =>
  error instanceof Error &&
  error.name === "UploadFileListingError" &&
  "code" in error &&
  error.code === "NOT_CONFIGURED";

const parseStateSkill = (path: string, content: string): PiSkillDefinition => {
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

export const loadBackofficePiSkills = async (state: PiSkillState): Promise<PiSkillRegistry> => {
  const staticPaths = await state.glob("/static/skills/**/SKILL.md");
  let workspacePaths: string[];
  try {
    workspacePaths = await state.glob("/workspace/skills/**/SKILL.md");
  } catch (error) {
    if (!isUploadNotConfiguredError(error)) {
      throw error;
    }
    workspacePaths = [];
  }

  const paths = [...staticPaths, ...workspacePaths];
  const contents = await Promise.all(paths.map((path) => state.readFile(path)));
  const skills: PiSkillRegistry = {};
  for (const [index, path] of paths.entries()) {
    try {
      const skill = parseStateSkill(path, contents[index]);
      skills[skill.name] = skill;
    } catch {
      continue;
    }
  }

  return skills;
};
