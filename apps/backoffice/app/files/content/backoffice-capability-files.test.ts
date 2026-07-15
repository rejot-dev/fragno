import { describe, expect, test } from "vitest";

import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import type { FileSystemArtifact } from "../types";
import { STATIC_FILE_CONTENT } from "./static";

const STATIC_CONTENT = STATIC_FILE_CONTENT as Record<string, FileSystemArtifact>;

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const readStaticText = (path: string) => {
  const content = STATIC_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected '${path}' to be string content.`);
  }
  return content;
};

const readSkillName = (skill: string) => {
  const match = /^name: (?<name>[^\n]+)$/mu.exec(skill);
  return match?.groups?.name ?? "";
};

describe("Backoffice capability static skills", () => {
  test("capability skills are spec-shaped static skills", () => {
    for (const capability of backofficeCapabilities) {
      const skillPaths = Object.keys(capability.files ?? {}).filter(
        (path) => path.startsWith("skills/") && path.endsWith("/SKILL.md"),
      );

      expect(skillPaths).toHaveLength(Object.keys(capability.files ?? {}).length);

      for (const skillPath of skillPaths) {
        const skill = readStaticText(skillPath);
        const skillName = readSkillName(skill);

        expect(skillName).toMatch(skillNamePattern);
        expect(skillPath).toBe(`skills/${skillName}/SKILL.md`);
        expect(capability.files?.[skillPath]).toBe(skill);
        expect(skill).toContain("description:");
        expect(skill).toContain("#");
        expect(STATIC_CONTENT[`skills/${skillName}/references/configuration.md`]).toBeUndefined();
        expect(STATIC_CONTENT[`skills/${skillName}/references/events.md`]).toBeUndefined();
        expect(STATIC_CONTENT[`skills/${skillName}/references/tools.md`]).toBeUndefined();
      }
    }
  });

  test("some capabilities intentionally rely on general system guidance instead of specific skills", () => {
    const capabilityIdsWithoutSkills = new Set(
      backofficeCapabilities
        .filter((capability) => !capability.files)
        .map((capability) => capability.id),
    );

    expect(capabilityIdsWithoutSkills).toEqual(
      new Set(["sandbox", "automations", "github", "auth"]),
    );
  });

  test("Telegram skill documents its primary event and tools", () => {
    const skill = readStaticText("skills/telegram-connection/SKILL.md");

    expect(skill).toContain("source`: `telegram`");
    expect(skill).toContain("eventType`: `message.received`");
    expect(skill).not.toContain("telegram:message.received");
    expect(skill).toContain("send chat messages");
  });

  test("MCP skill documents OAuth setup and tools", () => {
    const skill = readStaticText("skills/mcp-connection/SKILL.md");

    expect(skill).toContain("public OAuth callback route");
    expect(skill).toContain('auth: { type: "oauth" }');
    expect(skill).toContain("mcp.refreshServer");
    expect(skill).toContain("server.configuration.changed");
  });

  test("general starter skills cover automations, connections, workflows, and sandbox", () => {
    expect(readStaticText("skills/building-automations/SKILL.md")).toContain("events.catalogList");
    expect(readStaticText("skills/building-automations/SKILL.md")).toContain("router.create");
    expect(readStaticText("skills/configuring-connections/SKILL.md")).toContain(
      "connections.configure",
    );
    expect(readStaticText("skills/workflows/SKILL.md")).toContain("defineWorkflow");
    expect(readStaticText("skills/sandbox/SKILL.md")).toContain("sandbox.startSandbox");
  });
});
