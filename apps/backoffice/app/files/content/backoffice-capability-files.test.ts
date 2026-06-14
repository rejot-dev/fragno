import { describe, expect, test } from "vitest";

import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import type { FileSystemArtifact } from "../types";
import { SYSTEM_FILE_CONTENT } from "./system";

const SYSTEM_CONTENT = SYSTEM_FILE_CONTENT as Record<string, FileSystemArtifact>;

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const readSystemText = (path: string) => {
  const content = SYSTEM_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected '${path}' to be string content.`);
  }
  return content;
};

const readSkillName = (skill: string) => {
  const match = /^name: (?<name>[^\n]+)$/mu.exec(skill);
  return match?.groups?.name ?? "";
};

describe("Backoffice capability system skills", () => {
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
      const skill = readSystemText(skillPath);
      const skillName = readSkillName(skill);

      expect(skillName).toMatch(skillNamePattern);
      expect(skillPath).toBe(`skills/${skillName}/SKILL.md`);
      expect(capability.files[skillPath]).toBe(skill);
      expect(skill).toContain("description:");
      expect(skill).toContain("#");
      expect(SYSTEM_CONTENT[`skills/${skillName}/references/configuration.md`]).toBeUndefined();
      expect(SYSTEM_CONTENT[`skills/${skillName}/references/events.md`]).toBeUndefined();
      expect(SYSTEM_CONTENT[`skills/${skillName}/references/tools.md`]).toBeUndefined();
    }
  });

  test("skips skills that are covered by system guidance or do not add capability-specific detail", () => {
    const capabilityIdsWithoutSkills = backofficeCapabilities
      .filter((capability) => !capability.files)
      .map((capability) => capability.id);

    expect(capabilityIdsWithoutSkills).toEqual([
      "sandbox",
      "automations",
      "github",
      "cloudflare",
      "auth",
    ]);
  });

  test("Telegram skill documents its primary event and tools", () => {
    const skill = readSystemText("skills/telegram-connection/SKILL.md");

    expect(skill).toContain("source`: `telegram`");
    expect(skill).toContain("eventType`: `message.received`");
    expect(skill).not.toContain("telegram:message.received");
    expect(skill).toContain("send chat messages");
  });

  test("MCP skill documents OAuth setup and tools", () => {
    const skill = readSystemText("skills/mcp-connection/SKILL.md");

    expect(skill).toContain("public OAuth callback route");
    expect(skill).toContain('auth: { type: "oauth" }');
    expect(skill).toContain("mcp.refreshServer");
    expect(skill).toContain("server.configuration.changed");
  });

  test("general starter skills cover automations, connections, workflows, and sandbox", () => {
    expect(readSystemText("skills/building-automations/SKILL.md")).toContain(
      "events.eventsCatalogList",
    );
    expect(readSystemText("skills/configuring-connections/SKILL.md")).toContain(
      "connections.configure",
    );
    expect(readSystemText("skills/workflows/SKILL.md")).toContain("defineWorkflow");
    expect(readSystemText("skills/sandbox/SKILL.md")).toContain("sandbox.startSandbox");
  });
});
