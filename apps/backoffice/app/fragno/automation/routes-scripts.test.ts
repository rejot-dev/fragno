import { beforeEach, describe, expect, test, assert } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import {
  createMasterFileSystem,
  createSystemFilesContext,
  SYSTEM_AUTOMATION_SCRIPT_PATHS,
} from "@/files";

import type { AutomationWorkflowsService } from "./definition";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";
import { createAutomationFragment } from "./index";

const createAutomation = (options?: {
  automationFileSystem?: Awaited<ReturnType<typeof createMasterFileSystem>>;
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
      ownerScope: { kind: "org", orgId: "org_123" },
      automationFileSystem: options?.automationFileSystem,
    },
    {
      databaseAdapter: new InMemoryAdapter({ idSeed: "automation-routes-scripts-test" }),
      dbRoundtripGuard: true,
      mountRoute: "/api/automations",
    },
    services,
  );
};

describe("automation routes /scripts", () => {
  let fragment: ReturnType<typeof createAutomation>;

  beforeEach(async () => {
    fragment = createAutomation({
      automationFileSystem: await createMasterFileSystem(
        createSystemFilesContext({ orgId: "org_123" }),
      ),
    });
  });

  test("lists system scripts from the filesystem", async () => {
    const response = await fragment.callRoute("GET", "/scripts");

    assert(response.type === "json");
    if (response.type === "json") {
      expect(response.data.length).toBeGreaterThan(0);
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: SYSTEM_AUTOMATION_SCRIPT_PATHS.workspaceFileInitialization.replace(
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
      "/workspace/automations/present.sh": "#!/usr/bin/env bash\necho ok",
      "/workspace/automations/present.cm.js": "async () => true",
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
