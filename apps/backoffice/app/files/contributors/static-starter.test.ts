import { describe, expect, test } from "vitest";

import { readFileSync } from "node:fs";

import { WORKSPACE_STARTER_CONTENT } from "@/files";

describe("workspace starter content", () => {
  test("defines editable starter files without exposing a /starter mount", () => {
    expect(WORKSPACE_STARTER_CONTENT["AGENTS.md"]).toContain("Workspace guidance");
    expect(WORKSPACE_STARTER_CONTENT["automations/router.cm.js"]).toContain(
      "workflow.createInstance",
    );
    expect(WORKSPACE_STARTER_CONTENT["automations/telegram-user-linking.workflow.js"]).toContain(
      "telegram-user-linking",
    );
    expect(WORKSPACE_STARTER_CONTENT["automations/telegram-user-pi-linking.workflow.js"]).toContain(
      "telegram-user-pi-linking",
    );
  });

  test("workspace seeding uses the exported starter content as its only source of truth", () => {
    const seedSource = readFileSync(
      new URL("../seed-workspace-starter-files.ts", import.meta.url),
      "utf8",
    );

    expect(seedSource).toContain("WORKSPACE_STARTER_CONTENT");
    expect(seedSource).not.toContain("WORKSPACE_STARTER_AUTOMATION_CONTENT");
    expect(seedSource).not.toContain("GENERAL_SKILL_CONTENT");
    expect(seedSource).not.toContain('"AGENTS.md":');
  });
});
