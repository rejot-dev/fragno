import { describe, expect, test } from "vitest";

import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import { STATIC_STARTER_CONTENT } from "./starter";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const readStarterText = (path: string) => {
  const content = STATIC_STARTER_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected '${path}' to be string content.`);
  }
  return content;
};

const readSkillName = (skill: string) => {
  const match = /^name: (?<name>[^\n]+)$/mu.exec(skill);
  return match?.groups?.name ?? "";
};

describe("Backoffice capability starter skills", () => {
  test("capabilities with files contribute one spec-shaped static skill", () => {
    for (const capability of backofficeCapabilities) {
      const skillPaths = Object.keys(capability.files ?? {}).filter(
        (path) => path.startsWith("skills/") && path.endsWith("/SKILL.md"),
      );

      if (!capability.files) {
        expect(skillPaths).toEqual([]);
        continue;
      }

      expect(skillPaths).toHaveLength(1);
      const skillPath = skillPaths[0]!;
      const skill = readStarterText(skillPath);
      const skillName = readSkillName(skill);

      expect(skillName).toMatch(skillNamePattern);
      expect(skillPath).toBe(`skills/${skillName}/SKILL.md`);
      expect(capability.files[skillPath]).toBe(skill);
      expect(skill).toContain("description:");
      expect(skill).toContain("#");
      expect(
        STATIC_STARTER_CONTENT[`skills/${skillName}/references/configuration.md`],
      ).toBeUndefined();
      expect(STATIC_STARTER_CONTENT[`skills/${skillName}/references/events.md`]).toBeUndefined();
      expect(STATIC_STARTER_CONTENT[`skills/${skillName}/references/tools.md`]).toBeUndefined();
    }
  });

  test("skips skills that are covered by system guidance or do not add capability-specific detail", () => {
    const capabilityIdsWithoutSkills = backofficeCapabilities
      .filter((capability) => !capability.files)
      .map((capability) => capability.id);

    expect(capabilityIdsWithoutSkills).toEqual(["automations", "github", "cloudflare", "auth"]);
  });

  test("Telegram skill documents its primary event and tools", () => {
    const skill = readStarterText("skills/telegram-connection/SKILL.md");

    expect(skill).toContain("source`: `telegram`");
    expect(skill).toContain("eventType`: `message.received`");
    expect(skill).not.toContain("telegram:message.received");
    expect(skill).toContain("send chat messages");
  });

  test("MCP skill documents OAuth setup and tools", () => {
    const skill = readStarterText("skills/mcp-connection/SKILL.md");

    expect(skill).toContain("public OAuth callback route");
    expect(skill).toContain('auth: { type: "oauth" }');
    expect(skill).toContain("mcp.listTools");
  });

  test("general starter skills cover automations, connections, workflows, and sandbox", () => {
    expect(readStarterText("skills/building-automations/SKILL.md")).toContain(
      "events.eventsCatalogList",
    );
    expect(readStarterText("skills/configuring-connections/SKILL.md")).toContain(
      "connections.configure",
    );
    expect(readStarterText("skills/workflows/SKILL.md")).toContain("defineWorkflow");
    expect(readStarterText("skills/sandbox/SKILL.md")).toContain("sandbox.startSandbox");
  });
});
