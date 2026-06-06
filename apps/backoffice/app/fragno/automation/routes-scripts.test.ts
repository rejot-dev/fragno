import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import type { AutomationWorkflowsService } from "./definition";
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

  test("lists runnable starter scripts from the filesystem catalog", async () => {
    const response = await fragment.callRoute("GET", "/scripts");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "router.js", engine: "codemode", key: "router" }),
        ]),
      );
      expect(response.data).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "telegram-claim-linking.workflow.js" }),
          expect.objectContaining({ path: "telegram-delayed-test-reply.workflow.js" }),
          expect.objectContaining({ path: "telegram-pi-session.workflow.js" }),
        ]),
      );
    }
  });

  test("loads scripts directly from the automation workspace", async () => {
    const response = await fragment.callRoute("GET", "/scripts");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data.length).toBeGreaterThan(0);
    }
  });
});
