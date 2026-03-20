import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import type { AutomationWorkflowsService } from "./definition";
import {
  AUTOMATION_BINDINGS_MANIFEST_PATH,
  createAutomationFragment,
  createDefaultAutomationFileSystem,
} from "./index";

const createAutomation = (options?: {
  automationFileSystem?: Awaited<ReturnType<typeof createDefaultAutomationFileSystem>>;
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
      automationFileSystem: await createDefaultAutomationFileSystem("org_123"),
    });
  });

  test("lists starter workspace scripts derived from the filesystem manifest", async () => {
    const response = await fragment.callRoute("GET", "/scripts");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data.length).toBeGreaterThan(0);
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "telegram-claim-linking.start",
            name: "Telegram claim linking start",
          }),
          expect.objectContaining({
            key: "telegram-claim-linking.complete",
            name: "Telegram claim linking completion",
          }),
          expect.objectContaining({
            key: "telegram-pi-session.ensure",
            name: "Telegram Pi session ensure (linked chat)",
          }),
        ]),
      );
    }
  });

  test("fails clearly when the automation manifest is malformed", async () => {
    const readInvalidFile = async (path: string) => {
      if (path === AUTOMATION_BINDINGS_MANIFEST_PATH) {
        return "{not-json}";
      }

      throw new Error(`Unexpected path: ${path}`);
    };
    const invalidFileSystem = {
      readFile: readInvalidFile,
      async readFileBuffer(path: string) {
        return new TextEncoder().encode(await readInvalidFile(path));
      },
      getAllPaths() {
        return [AUTOMATION_BINDINGS_MANIFEST_PATH];
      },
    } as Awaited<ReturnType<typeof createDefaultAutomationFileSystem>>;

    const invalidFragment = createAutomation({
      automationFileSystem: invalidFileSystem,
    });

    const response = await invalidFragment.callRoute("GET", "/scripts");

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(500);
      expect(response.error.message).toContain("Automation manifest");
      expect(response.error.message).toContain("not valid JSON");
    }
  });
});
