import { describe, expect, test } from "vitest";

import { STATIC_AUTOMATION_CONTENT } from "@/files/content/static-automations";
import { SYSTEM_AUTOMATION_CONTENT } from "@/files/content/system-automations";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";

import {
  AUTOMATION_SCRIPTS_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  listAutomationWorkspaceScripts,
  loadAutomationCatalog,
  readAutomationWorkspaceScript,
} from "./catalog";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";

const telegramChannelEntry = getStaticMarketplaceEntry({
  slug: "telegram-channel",
  version: "1.0.0",
});
if (!telegramChannelEntry) {
  throw new Error("Expected the built-in Telegram Channel Marketplace entry.");
}

const telegramChannelWorkflowContent = Object.fromEntries(
  Object.entries(telegramChannelEntry.files).filter(([path]) => path.startsWith("automations/")),
);

const createAutomationFileSystem = async (files: Record<string, string> = {}) =>
  createTestMasterFileSystem(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        `${AUTOMATION_WORKSPACE_ROOT}/${path.replace(/^automations\//u, "")}`,
        content,
      ]),
    ),
  );

describe("automation filesystem catalog", () => {
  test("loads static, system, and Marketplace-installed workspace workflow files", async () => {
    const fileSystem = createTestMasterFileSystem({
      ...Object.fromEntries(
        Object.entries(STATIC_AUTOMATION_CONTENT).map(([path, content]) => [
          `/static/${path}`,
          content,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(SYSTEM_AUTOMATION_CONTENT).map(([path, content]) => [
          `/system/${path}`,
          content,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(telegramChannelWorkflowContent).map(([path, content]) => [
          `/workspace/${path}`,
          content,
        ]),
      ),
    });

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "telegram-user-linking.workflow.js", enabled: false }),
        expect.objectContaining({ path: "telegram-user-pi-linking.workflow.js", enabled: false }),
      ]),
    );
  });

  test("loads Marketplace-installed automation scripts from /workspace", async () => {
    const fileSystem = await createAutomationFileSystem(telegramChannelWorkflowContent);

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.bindings).toEqual([]);
    expect(catalog.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "telegram-user-linking.workflow.js",
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
