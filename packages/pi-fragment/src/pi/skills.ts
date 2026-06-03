import { Type } from "typebox";

import type { PiToolDefinition } from "./types";

export type PiSkillResource = {
  path: string;
  description?: string;
  content?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
};

export type PiSkillDefinition = {
  name: string;
  description: string;
  body?: string;
  location?: string;
  directory?: string;
  resources?: readonly PiSkillResource[];
  metadata?: Record<string, unknown>;
};

export type PiSkillDefinitionInput = Omit<PiSkillDefinition, "name"> & {
  name?: string;
};

export type PiSkillRegistry = Record<string, PiSkillDefinition>;

export type PiSkillCatalogXmlInput = PiSkillRegistry | readonly PiSkillDefinition[];

export type PiSkillActivationDetails =
  | {
      found: true;
      name: string;
      resourceCount: number;
    }
  | {
      found: false;
      name: string;
    };

export type CreatePiSkillActivationToolOptions = {
  name?: string;
  label?: string;
  description?: string;
};

export type PiSkillInvocationContextOptions = {
  extraUserInstructions?: string;
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const skillCatalogEntries = (skills: PiSkillCatalogXmlInput) =>
  (Array.isArray(skills) ? skills : Object.values(skills)).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );

export const renderPiSkillCatalogXml = (skills: PiSkillCatalogXmlInput): string => {
  const entries = skillCatalogEntries(skills);
  if (entries.length === 0) {
    return "";
  }

  const skillXml = entries
    .map(
      (skill) => `  <skill>
    <name>${escapeXml(skill.name)}</name>
    <description>${escapeXml(skill.description)}</description>
  </skill>`,
    )
    .join("\n");

  return `<available_skills>
${skillXml}
</available_skills>`;
};

const renderSkillResourceXml = (resource: PiSkillResource) => {
  const fields = [
    `      <path>${escapeXml(resource.path)}</path>`,
    resource.description === undefined
      ? undefined
      : `      <description>${escapeXml(resource.description)}</description>`,
    resource.mimeType === undefined
      ? undefined
      : `      <mimeType>${escapeXml(resource.mimeType)}</mimeType>`,
  ].filter((field): field is string => field !== undefined);

  return `    <file>\n${fields.join("\n")}\n    </file>`;
};

const inferSkillDirectory = (skill: PiSkillDefinition) => {
  if (skill.directory !== undefined) {
    return skill.directory;
  }
  if (skill.location === undefined) {
    return undefined;
  }

  const normalizedLocation = skill.location.replaceAll("\\", "/");
  const lastSlash = normalizedLocation.lastIndexOf("/");
  if (lastSlash === -1) {
    return undefined;
  }
  return normalizedLocation.slice(0, lastSlash);
};

const renderPiSkillActivationXml = (skill: PiSkillDefinition): string => {
  const directory = inferSkillDirectory(skill);
  const sections = [
    `<name>${escapeXml(skill.name)}</name>`,
    `<description>${escapeXml(skill.description)}</description>`,
    skill.body === undefined ? undefined : `<body>\n${escapeXml(skill.body)}\n</body>`,
    directory === undefined ? undefined : `<directory>${escapeXml(directory)}</directory>`,
    skill.location === undefined ? undefined : `<location>${escapeXml(skill.location)}</location>`,
    skill.resources?.length
      ? `<resource_path_note>Resource file paths are relative to the skill itself.</resource_path_note>`
      : undefined,
    skill.resources?.length
      ? `<skill_resources>\n${skill.resources.map(renderSkillResourceXml).join("\n")}\n</skill_resources>`
      : undefined,
  ].filter((section): section is string => section !== undefined);

  return `<skill_content name="${escapeXml(skill.name)}">\n${sections.join("\n")}\n</skill_content>`;
};

export const renderPiSkillInvocationContext = (
  skill: PiSkillDefinition,
  options: PiSkillInvocationContextOptions = {},
): string => {
  const skillInvocationXml = renderPiSkillActivationXml(skill);
  if (!options.extraUserInstructions) {
    return skillInvocationXml;
  }

  return `${skillInvocationXml}\n\n${options.extraUserInstructions}`;
};

const findSkill = (skills: PiSkillCatalogXmlInput, name: string) => {
  if (Array.isArray(skills)) {
    return skills.find((skill) => skill.name === name);
  }
  return (skills as PiSkillRegistry)[name];
};

const skillActivationParameters = Type.Object({ name: Type.String() });

export const createPiSkillActivationTool = (
  skills: PiSkillCatalogXmlInput,
  options: CreatePiSkillActivationToolOptions = {},
): PiToolDefinition<typeof skillActivationParameters, PiSkillActivationDetails> => ({
  name: options.name ?? "activate_skill",
  label: options.label ?? "Activate skill",
  description:
    options.description ?? "Load the full instructions for a registered Pi skill by name.",
  parameters: skillActivationParameters,
  async execute(_toolCallId, params) {
    const skill = findSkill(skills, params.name);
    if (!skill) {
      return {
        content: [{ type: "text", text: `Skill '${params.name}' was not found.` }],
        details: { found: false, name: params.name },
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: renderPiSkillActivationXml(skill) }],
      details: {
        found: true,
        name: skill.name,
        resourceCount: skill.resources?.length ?? 0,
      },
    };
  },
});

export class PiSkillDefinitionBuilder<TName extends string = string> {
  readonly #name: TName;
  #description: string | undefined;
  #body: string | undefined;
  #location: string | undefined;
  #directory: string | undefined;
  #resources: PiSkillResource[] = [];
  #metadata: Record<string, unknown> | undefined;

  constructor(name: TName) {
    this.#name = name;
  }

  description(description: string): this {
    this.#description = description;
    return this;
  }

  body(body: string): this {
    this.#body = body;
    return this;
  }

  location(location: string): this {
    this.#location = location;
    return this;
  }

  directory(directory: string): this {
    this.#directory = directory;
    return this;
  }

  resource(path: string, resource: Omit<PiSkillResource, "path"> = {}): this {
    this.#resources.push({ ...resource, path });
    return this;
  }

  resources(resources: readonly PiSkillResource[]): this {
    this.#resources = [...resources];
    return this;
  }

  metadata(metadata: Record<string, unknown>): this {
    this.#metadata = { ...metadata };
    return this;
  }

  metadataValue(key: string, value: unknown): this {
    this.#metadata = { ...this.#metadata, [key]: value };
    return this;
  }

  build(): PiSkillDefinition {
    if (!this.#description) {
      throw new Error(`Skill '${this.#name}' must define a description.`);
    }

    return {
      name: this.#name,
      description: this.#description,
      ...(this.#body === undefined ? {} : { body: this.#body }),
      ...(this.#location === undefined ? {} : { location: this.#location }),
      ...(this.#directory === undefined ? {} : { directory: this.#directory }),
      ...(this.#resources.length === 0 ? {} : { resources: [...this.#resources] }),
      ...(this.#metadata === undefined ? {} : { metadata: { ...this.#metadata } }),
    };
  }
}
