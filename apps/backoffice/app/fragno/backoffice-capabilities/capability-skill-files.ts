type BackofficeCapabilitySkillFilesInput = {
  /**
   * Agent Skills spec name. Must match the generated skill directory name and use lowercase
   * letters, numbers, and hyphens only.
   */
  name: string;
  /**
   * Frontmatter description used by agents to decide when to load the skill. Keep it
   * trigger-oriented and keyword-rich.
   */
  description: string;
  /** Human-readable Markdown H1 shown at the top of SKILL.md. */
  title: string;
  /** Short body introduction shown after the skill is already selected. */
  overview: string;
  /** Capability setup and configuration guidance. */
  configuration: string;
  /** Automation events, hook behavior, event schemas, and inspection guidance. */
  events: string;
  /** Runtime tools, commands, providers, and usage examples for this capability. */
  tools: string;
};

export const createCapabilitySkillFiles = ({
  name,
  description,
  title,
  overview,
  configuration,
  events,
  tools,
}: BackofficeCapabilitySkillFilesInput): Record<string, string> => ({
  [`skills/${name}/SKILL.md`]: `---
name: ${name}
description: ${description}
---

# ${title}

${overview}

${configuration}

${events}

${tools}
`,
});
