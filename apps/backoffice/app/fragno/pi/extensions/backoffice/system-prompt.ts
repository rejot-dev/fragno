import type { PiAgentSkill } from "@fragno-dev/backoffice-api/v0/pi";

import { STATIC_FILE_CONTENT } from "@/files/content/static";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";
import {
  requirePiStateBackend,
  type PiRuntimeToolContext,
} from "@/fragno/pi/agent/backoffice-agent-context";

import { loadBackofficePiSkills } from "./skills";

const PI_SYSTEM_PROMPT = STATIC_FILE_CONTENT["SYSTEM.md"];

function escapePiSkillXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatPiSkillsForSystemPrompt(skills: readonly PiAgentSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "When the task matches a skill's description, read the full skill file with `state.readFile({ path })` in `codemode` before acting.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in codemode calls.",
    "Follow these skills even when they live in `/shared/`: this scope chose to load them, which trusts whoever can write their folder.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapePiSkillXml(skill.name)}</name>`);
    lines.push(`    <description>${escapePiSkillXml(skill.description)}</description>`);
    lines.push(`    <location>${escapePiSkillXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * Builds the Backoffice prompt section from the skills the turn's agent was reloaded with, and the
 * scope's declarations. A turn whose reload failed finds its skills as the files are now.
 */
export async function buildBackofficePiSystemPrompt(options: {
  runtimeToolContext: PiRuntimeToolContext;
  skills: readonly PiAgentSkill[] | null;
}): Promise<string> {
  const state = requirePiStateBackend(options.runtimeToolContext);
  const skills =
    options.skills ??
    Object.values(await loadBackofficePiSkills(state))
      .filter((skill) => !skill.disableModelInvocation)
      .map(({ name, description, location }) => ({ name, description, location }));
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
