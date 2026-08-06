import { describe, expect, test } from "vitest";

import type { FileContent } from "../interface";
import { GENERAL_SKILL_CONTENT } from "./skills";

const skillContent = GENERAL_SKILL_CONTENT as Record<string, FileContent>;
const buildingAutomationsSkill = skillContent["skills/building-automations/SKILL.md"];
const workflowsSkill = skillContent["skills/workflows/SKILL.md"];

if (typeof buildingAutomationsSkill !== "string" || typeof workflowsSkill !== "string") {
  throw new Error("Expected built-in automation skills to contain text.");
}

describe("built-in automation skills", () => {
  test("writes saved workflow examples with real newlines", () => {
    expect(buildingAutomationsSkill).toContain("`defineWorkflow(\n");
    expect(buildingAutomationsSkill).not.toContain("\\\\n");
    expect(buildingAutomationsSkill).toContain("with a `.workflow.js` suffix");
  });

  test("keeps the inline workflow example syntactically valid", () => {
    expect(workflowsSkill).toContain("async (event, step) =>");
    expect(workflowsSkill).not.toContain("\\_event");
  });
});
