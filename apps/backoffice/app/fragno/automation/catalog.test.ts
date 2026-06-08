import { describe, expect, test } from "vitest";

import { STARTER_AUTOMATION_CONTENT, STARTER_AUTOMATION_SCRIPT_PATHS } from "@/files";

import {
  AUTOMATION_SCRIPTS_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  listAutomationWorkspaceScripts,
  loadAutomationCatalog,
  readAutomationWorkspaceScript,
} from "./catalog";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";

const createAutomationFileSystem = async (files: Record<string, string> = {}) =>
  createTestMasterFileSystem(
    Object.fromEntries(
      Object.entries({ ...STARTER_AUTOMATION_CONTENT, ...files }).map(([path, content]) => [
        `${AUTOMATION_WORKSPACE_ROOT}/${path.replace(/^automations\//u, "")}`,
        content,
      ]),
    ),
  );

describe("automation filesystem catalog", () => {
  test("loads starter automation scripts from /starter", async () => {
    const fileSystem = await createAutomationFileSystem();

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.bindings).toEqual([]);
    expect(catalog.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "router.cm",
          path: STARTER_AUTOMATION_SCRIPT_PATHS.router.replace(/^automations\//u, ""),
          engine: "codemode",
          enabled: true,
        }),
        expect.objectContaining({
          path: STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinking.replace(/^automations\//u, ""),
          enabled: false,
        }),
      ]),
    );
  });

  test("lists scripts recursively under the automation scripts root", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/scripts/custom.sh": "echo custom",
      "automations/scripts/nested/custom.cm.js": "async () => true",
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "scripts/custom.sh",
          absolutePath: `${AUTOMATION_SCRIPTS_ROOT}/custom.sh`,
          engine: "bash",
          kind: "script",
        }),
        expect.objectContaining({
          path: "scripts/nested/custom.cm.js",
          absolutePath: `${AUTOMATION_SCRIPTS_ROOT}/nested/custom.cm.js`,
          engine: "codemode",
          kind: "script",
        }),
      ]),
    );
  });

  test("reads individual automation script source lazily", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/scripts/lazy.sh": "echo lazy",
    });

    await expect(readAutomationWorkspaceScript(fileSystem, "scripts/lazy.sh")).resolves.toEqual(
      expect.objectContaining({
        path: "scripts/lazy.sh",
        body: "echo lazy",
        engine: "bash",
      }),
    );
  });
});
