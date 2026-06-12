import { beforeEach, describe, expect, test, assert } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import { STARTER_AUTOMATION_SCRIPT_PATHS } from "@/files";

import type { AutomationWorkflowsService } from "./definition";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";
import { createAutomationFragment, createMinimalFileSystem } from "./index";

const createAutomation = (options?: {
  automationFileSystem?: Awaited<ReturnType<typeof createMinimalFileSystem>>;
}) => {
  const services = {
    workflows: {
      createInstance: async () => ({}),
      getInstanceStatus: async () => [],
      getLiveInstanceState: async () => ({}),
      restoreInstanceState: async () => ({}),
      sendEvent: async () => ({}),
    } as unknown as AutomationWorkflowsService,
  };

  return createAutomationFragment(
    {
      automationFileSystem: options?.automationFileSystem,
    },
    {
      databaseAdapter: new InMemoryAdapter({ idSeed: "automation-routes-scripts-test" }),
      dbRoundtripGuard: true,
      mountRoute: "/api/automations/bindings",
    },
    services,
  );
};

describe("automation routes /scripts", () => {
  let fragment: ReturnType<typeof createAutomation>;

  beforeEach(async () => {
    fragment = createAutomation({
      automationFileSystem: await createMinimalFileSystem("org_123"),
    });
  });

  test("lists static starter scripts from the filesystem", async () => {
    const response = await fragment.callRoute("GET", "/scripts");

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data.length).toBeGreaterThan(0);
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: STARTER_AUTOMATION_SCRIPT_PATHS.router.replace(/^automations\//u, ""),
            engine: "codemode",
            enabled: true,
          }),
          expect.objectContaining({
            path: STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinking.replace(
              /^automations\//u,
              "",
            ),
            enabled: false,
          }),
        ]),
      );
    }
  });

  test("loads scripts from a custom filesystem", async () => {
    const fileSystem = await createTestMasterFileSystem({
      "/starter/automations/scripts/present.sh": "#!/usr/bin/env bash\necho ok",
      "/starter/automations/scripts/present.cm.js": "async () => true",
    });
    const partialFragment = createAutomation({ automationFileSystem: fileSystem });

    const response = await partialFragment.callRoute("GET", "/scripts");

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "present", engine: "bash", scriptLoadError: null }),
          expect.objectContaining({ key: "present.cm", engine: "codemode" }),
        ]),
      );
    }
  });
});
