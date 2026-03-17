import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import type { AutomationWorkflowsService } from "./definition";
import { createAutomationFragment } from "./index";

const createAutomation = () => {
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
    {},
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

  beforeEach(() => {
    fragment = createAutomation();
  });

  test("returns empty list initially", async () => {
    const response = await fragment.callRoute("GET", "/scripts");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data).toEqual([]);
    }
  });

  test("creates and lists a script", async () => {
    const createResponse = await fragment.callRoute("POST", "/scripts", {
      body: {
        key: "  welcome-script  ",
        name: "  Welcome Message  ",
        engine: "bash",
        script: "  echo hi  ",
        version: 1,
        enabled: true,
      },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type === "json") {
      expect(typeof createResponse.data.id).toBe("string");
    }

    const listResponse = await fragment.callRoute("GET", "/scripts", {
      query: {},
    });

    expect(listResponse.type).toBe("json");
    if (listResponse.type === "json") {
      expect(listResponse.data).toHaveLength(1);
      expect(listResponse.data[0]).toMatchObject({
        key: "welcome-script",
        name: "Welcome Message",
        engine: "bash",
        script: "echo hi",
        version: 1,
        enabled: true,
      });
    }
  });

  test("rejects invalid script payloads", async () => {
    const response = await fragment.callRoute("POST", "/scripts", {
      body: {
        key: "   ",
        name: "   ",
        engine: "node",
        script: "   ",
        version: 0,
        enabled: true,
      },
    } as never);

    expect(response.type).toBe("error");
    if (response.type === "error") {
      expect(response.status).toBe(400);
    }
  });
});
