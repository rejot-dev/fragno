import { describe, expect, test } from "vitest";

import { STARTER_AUTOMATION_SCRIPT_PATHS } from "@/files";
import { WORKSPACE_STARTER_AUTOMATION_CONTENT } from "@/files/content/starter-automations";
import { SYSTEM_AUTOMATION_CONTENT } from "@/files/content/system-automations";

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
      Object.entries({ ...WORKSPACE_STARTER_AUTOMATION_CONTENT, ...files }).map(
        ([path, content]) => [
          `${AUTOMATION_WORKSPACE_ROOT}/${path.replace(/^automations\//u, "")}`,
          content,
        ],
      ),
    ),
  );

describe("automation filesystem catalog", () => {
  test("loads enabled routers from both /system and /workspace", async () => {
    const fileSystem = createTestMasterFileSystem({
      ...Object.fromEntries(
        Object.entries(SYSTEM_AUTOMATION_CONTENT).map(([path, content]) => [
          `/system/${path}`,
          content,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(WORKSPACE_STARTER_AUTOMATION_CONTENT).map(([path, content]) => [
          `/workspace/${path}`,
          content,
        ]),
      ),
    });

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "script:system:router.cm@1:router.cm.js",
          absolutePath: "/system/automations/router.cm.js",
          enabled: true,
        }),
        expect.objectContaining({
          id: "script:workspace:router.cm@1:router.cm.js",
          absolutePath: "/workspace/automations/router.cm.js",
          enabled: true,
        }),
      ]),
    );
  });

  test("loads workspace starter automation scripts from /workspace", async () => {
    const fileSystem = await createAutomationFileSystem();

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.bindings).toEqual([]);
    expect(catalog.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "router.cm",
          path: STARTER_AUTOMATION_SCRIPT_PATHS.workspaceRouter.replace(/^automations\//u, ""),
          engine: "codemode",
          enabled: true,
        }),
        expect.objectContaining({
          path: STARTER_AUTOMATION_SCRIPT_PATHS.telegramUserLinking.replace(/^automations\//u, ""),
          enabled: false,
        }),
      ]),
    );
  });

  test("lists scripts recursively under the automation scripts root", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/custom.sh": "echo custom",
      "automations/nested/custom.cm.js": "async () => true",
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "custom.sh",
          absolutePath: `${AUTOMATION_SCRIPTS_ROOT}/custom.sh`,
          engine: "bash",
          kind: "script",
        }),
        expect.objectContaining({
          path: "nested/custom.cm.js",
          absolutePath: `${AUTOMATION_SCRIPTS_ROOT}/nested/custom.cm.js`,
          engine: "codemode",
          kind: "script",
        }),
      ]),
    );
  });

  test("reads individual automation script source lazily", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/lazy.sh": "echo lazy",
    });

    await expect(readAutomationWorkspaceScript(fileSystem, "lazy.sh")).resolves.toEqual(
      expect.objectContaining({
        path: "lazy.sh",
        body: "echo lazy",
        engine: "bash",
      }),
    );
  });
});
