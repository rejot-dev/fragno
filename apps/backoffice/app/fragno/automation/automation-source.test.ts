import { describe, expect, test } from "vitest";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";

import { AUTOMATION_WORKSPACE_ROOT, readAutomationScript } from "./automation-source";
import { createTestAutomationSourceReader } from "./test-automation-source-reader.test-utils";

const execution = createBackofficeSystemExecution({ kind: "system" });

describe("automation source", () => {
  test("reads a workspace automation by relative path", async () => {
    const sourceReader = createTestAutomationSourceReader({
      [`${AUTOMATION_WORKSPACE_ROOT}/lazy.workflow.js`]: "export default async () => undefined;",
    });

    await expect(
      readAutomationScript(sourceReader, { execution, scriptPath: "lazy.workflow.js" }),
    ).resolves.toEqual({
      absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/lazy.workflow.js`,
      body: "export default async () => undefined;",
    });
  });

  test("reads an automation by absolute path", async () => {
    const absolutePath = "/static/automations/project.workflow.js";
    const sourceReader = createTestAutomationSourceReader({
      [absolutePath]: "export default async () => undefined;",
    });

    await expect(
      readAutomationScript(sourceReader, { execution, scriptPath: absolutePath }),
    ).resolves.toEqual({
      absolutePath,
      body: "export default async () => undefined;",
    });
  });
});
