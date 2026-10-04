import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";

import { requirePiStateBackend, type PiRuntimeToolContext } from "./pi-runtime-context";
import { PI_SYSTEM_PROMPT } from "./pi-shared";
import { loadBackofficePiSkills } from "./pi-skills";

type BackofficePiSkill = {
  name: string;
  description: string;
  filePath: string;
};

function escapePiSkillXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatPiSkillsForSystemPrompt(skills: readonly BackofficePiSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapePiSkillXml(skill.name)}</name>`);
    lines.push(`    <description>${escapePiSkillXml(skill.description)}</description>`);
    lines.push(`    <location>${escapePiSkillXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Builds the Backoffice prompt section from the current scope's skills and declarations. */
export async function buildBackofficePiSystemPrompt(options: {
  runtimeToolContext: PiRuntimeToolContext;
}): Promise<string> {
  const state = requirePiStateBackend(options.runtimeToolContext);
  const skillRegistry = await loadBackofficePiSkills(state);
  const skills = Object.values(skillRegistry).map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.location,
  }));
  const baseSystemPrompt = [PI_SYSTEM_PROMPT, formatPiSkillsForSystemPrompt(skills)]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const renderedStaticGuidance = await renderCodemodeSystemPrompt({ state });
  const expandedDefaultGuidance = baseSystemPrompt.replace(
    PI_SYSTEM_PROMPT,
    renderedStaticGuidance,
  );
  return expandedDefaultGuidance === baseSystemPrompt
    ? `${baseSystemPrompt}\n\n${renderedStaticGuidance}`
    : expandedDefaultGuidance;
}
