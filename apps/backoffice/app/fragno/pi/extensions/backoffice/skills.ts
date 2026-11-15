import type { PiAgentSkillReload } from "@fragno-dev/backoffice-api/v0/pi";

import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import { parseFrontmatter } from "@/lib/frontmatter";

/**
 * A skill, from a `SKILL.md`'s frontmatter and body. `disableModelInvocation`, from
 * `disable-model-invocation: true`, leaves it out of the skills agents are offered: only an agent
 * told its path reads it, as an app's package tells its agent.
 */
export type BackofficePiSkillDefinition = {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  body: string;
  directory: string;
  location: string;
};
export type BackofficePiSkillRegistry = Record<string, BackofficePiSkillDefinition>;

type SkillFrontmatter = { name: string; description: string } & Record<string, unknown>;
type PiSkillState = Pick<BackofficeStateBackend, "glob" | "readFile" | "exists">;

/** Workspace content is optional: runtimes without Upload expose only `/static`. */
export const isUploadNotConfiguredError = (
  error: unknown,
): error is Error & { name: "UploadFileListingError"; code: "NOT_CONFIGURED" } =>
  error instanceof Error &&
  error.name === "UploadFileListingError" &&
  "code" in error &&
  error.code === "NOT_CONFIGURED";

const parseStateSkill = (path: string, content: string): BackofficePiSkillDefinition => {
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
  const disableModelInvocation = frontmatter["disable-model-invocation"] ?? false;
  if (typeof disableModelInvocation !== "boolean") {
    throw new Error(`Skill ${path} has non-boolean frontmatter field 'disable-model-invocation'.`);
  }

  const directory = path.slice(0, path.lastIndexOf("/"));
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    disableModelInvocation,
    body,
    directory,
    location: path,
  };
};

async function globSkills(state: PiSkillState, pattern: string): Promise<string[]> {
  try {
    return await state.glob(pattern);
  } catch (error) {
    if (!isUploadNotConfiguredError(error)) {
      throw error;
    }
    return [];
  }
}

/**
 * Reads every skill under `/static/skills`, the agent's `folders`, and `/workspace`'s `skills`
 * folders, by name, with the files and folders it could not read. Of skills sharing a name, the
 * later wins: a scope's own over a folder's, as it is the more specific, and a folder's over
 * Backoffice's.
 */
async function scanBackofficePiSkills(
  state: PiSkillState,
  folders: readonly string[],
): Promise<{ registry: BackofficePiSkillRegistry; problems: PiAgentSkillReload["problems"] }> {
  const [staticPaths, folderPaths, workspacePaths] = await Promise.all([
    globSkills(state, "/static/skills/**/SKILL.md"),
    Promise.all(folders.map((folder) => globSkills(state, `${folder}/**/SKILL.md`))),
    globSkills(state, "/workspace/**/skills/**/SKILL.md"),
  ]);
  const problems: PiAgentSkillReload["problems"] = [];
  // A folder the definition names may be a share this scope never accepted, or accepted under
  // another name; finding no skills there would otherwise look like an empty folder.
  for (const [index, folder] of folders.entries()) {
    if (folderPaths[index].length === 0 && !(await state.exists(folder))) {
      problems.push({ path: folder, message: "Folder not found." });
    }
  }
  const paths = [...staticPaths, ...folderPaths.flat(), ...workspacePaths];
  const contents = await Promise.allSettled(paths.map((path) => state.readFile(path)));
  const registry: BackofficePiSkillRegistry = {};
  for (const [index, path] of paths.entries()) {
    const content = contents[index];
    try {
      if (content.status === "rejected") {
        throw content.reason;
      }
      const skill = parseStateSkill(path, content.value);
      const shadowed = registry[skill.name];
      if (shadowed) {
        problems.push({
          path: shadowed.location,
          message: `Skill '${skill.name}' is offered from ${path} instead.`,
        });
      }
      registry[skill.name] = skill;
    } catch (error) {
      problems.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { registry, problems };
}

/** The skills an agent finds as the files are now, for a turn whose reload failed. */
export const loadBackofficePiSkills = async (
  state: PiSkillState,
): Promise<BackofficePiSkillRegistry> => (await scanBackofficePiSkills(state, [])).registry;

/** What a reload offers an agent whose definition names `folders`: frontmatter, never bodies. */
export async function reloadBackofficePiSkills(
  state: PiSkillState,
  folders: readonly string[],
): Promise<PiAgentSkillReload> {
  const { registry, problems } = await scanBackofficePiSkills(state, folders);
  return {
    skills: Object.values(registry)
      .filter((skill) => !skill.disableModelInvocation)
      .map(({ name, description, location }) => ({ name, description, location })),
    problems,
  };
}
