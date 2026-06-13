import { describe, expect, test } from "vitest";

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
});
