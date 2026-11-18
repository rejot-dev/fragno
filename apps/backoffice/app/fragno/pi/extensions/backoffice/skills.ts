import type {
  PiAgentDefinition,
  PiAgentSkillListing,
  PiAgentSkillReload,
} from "@fragno-dev/backoffice-api/v0/pi";

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

type PiSkillSource = PiAgentSkillListing["skills"][number]["source"];
type PiSkillStatus = PiAgentSkillListing["skills"][number]["status"];

/** Where an agent finds its skills: the definition's folders and built-in skills it disables. */
export type PiSkillSelection = Pick<PiAgentDefinition, "skills" | "disabledSkills">;

/**
 * Reads every skill under `/static/skills`, the agent's `folders`, and `/workspace`'s `skills`
 * folders, each with its source and status, and the files and folders it could not read. Of skills
 * sharing a name, the later wins: a scope's own over a folder's, as it is the more specific, and a
 * folder's over Backoffice's. A disabled built-in skill replaces nothing.
 */
async function scanBackofficePiSkills(
  state: PiSkillState,
  { skills: folders, disabledSkills }: PiSkillSelection,
): Promise<{
  skills: (BackofficePiSkillDefinition & { source: PiSkillSource; status: PiSkillStatus })[];
  problems: PiAgentSkillReload["problems"];
}> {
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
  const builtIn = new Set(staticPaths);
  for (const location of disabledSkills) {
    if (!builtIn.has(location)) {
      problems.push({ path: location, message: "Disabled skill not found." });
    }
  }
  // A folder under `/workspace` is found twice. The file is one skill, from its last source and at
  // its place there, so it still replaces a folder's skill named after it.
  const sourced = new Map<string, PiSkillSource>();
  function source(path: string, from: PiSkillSource) {
    sourced.delete(path);
    sourced.set(path, from);
  }
  for (const path of staticPaths) {
    source(path, { kind: "static" });
  }
  for (const [index, folder] of folders.entries()) {
    for (const path of folderPaths[index]) {
      source(path, { kind: "folder", folder });
    }
  }
  for (const path of workspacePaths) {
    source(path, { kind: "workspace" });
  }
  const entries = [...sourced];
  const contents = await Promise.allSettled(entries.map(([path]) => state.readFile(path)));
  const found: (BackofficePiSkillDefinition & { source: PiSkillSource })[] = [];
  for (const [index, [path, source]] of entries.entries()) {
    const content = contents[index];
    try {
      if (content.status === "rejected") {
        throw content.reason;
      }
      found.push({ ...parseStateSkill(path, content.value), source });
    } catch (error) {
      problems.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const disabled = new Set(disabledSkills);
  const winners = new Map<string, BackofficePiSkillDefinition>();
  for (const skill of found) {
    if (!disabled.has(skill.location)) {
      winners.set(skill.name, skill);
    }
  }
  return {
    skills: found.map((skill) => ({ ...skill, status: skillStatus(skill, disabled, winners) })),
    problems,
  };
}

function skillStatus(
  skill: BackofficePiSkillDefinition,
  disabled: ReadonlySet<string>,
  winners: ReadonlyMap<string, BackofficePiSkillDefinition>,
): PiSkillStatus {
  if (disabled.has(skill.location)) {
    return { kind: "disabled" };
  }
  const winner = winners.get(skill.name);
  if (winner && winner !== skill) {
    return { kind: "replaced", by: winner.location };
  }
  return skill.disableModelInvocation ? { kind: "hidden" } : { kind: "offered" };
}

/** The skills an agent is offered as the files are now, by name, for a turn whose reload failed. */
export async function loadBackofficePiSkills(
  state: PiSkillState,
  selection: PiSkillSelection,
): Promise<BackofficePiSkillRegistry> {
  const { skills } = await scanBackofficePiSkills(state, selection);
  return Object.fromEntries(
    skills.filter(({ status }) => status.kind === "offered").map((skill) => [skill.name, skill]),
  );
}

/** What a reload offers an agent: the frontmatter of the skills its definition selects. */
export async function reloadBackofficePiSkills(
  state: PiSkillState,
  selection: PiSkillSelection,
): Promise<PiAgentSkillReload> {
  const { skills, problems } = await scanBackofficePiSkills(state, selection);
  return {
    skills: skills
      .filter(({ status }) => status.kind === "offered")
      .map(({ name, description, location }) => ({ name, description, location })),
    // The agent hears which skill it is offered instead; a listing says so in the status.
    problems: [
      ...problems,
      ...skills.flatMap(({ name, location, status }) =>
        status.kind === "replaced"
          ? [{ path: location, message: `Skill '${name}' is offered from ${status.by} instead.` }]
          : [],
      ),
    ],
  };
}

/** Every skill an agent finds, with where it found it and whether it is offered. */
export async function listBackofficePiSkills(
  state: PiSkillState,
  selection: PiSkillSelection,
): Promise<PiAgentSkillListing> {
  const { skills, problems } = await scanBackofficePiSkills(state, selection);
  return {
    skills: skills.map(({ name, description, location, source, status }) => ({
      name,
      description,
      location,
      source,
      status,
    })),
    problems,
  };
}
