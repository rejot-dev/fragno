import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import type { AutomationWorkflowsService } from "./definition";
import {
  createAutomationFragment,
  createMinimalFileSystem,
  type AutomationScenarioCatalogEntry,
  type AutomationSimulationResult,
} from "./index";

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
      databaseAdapter: new InMemoryAdapter({ idSeed: "automation-routes-scenarios-test" }),
      dbRoundtripGuard: true,
      mountRoute: "/api/automations/bindings",
    },
    services,
  );
};

describe("automation routes /scenarios", () => {
  let fragment: ReturnType<typeof createAutomation>;

  beforeEach(async () => {
    fragment = createAutomation({
      automationFileSystem: await createMinimalFileSystem("org_123"),
    });
  });

  test("lists starter automation simulator scenarios", async () => {
    const response = await fragment.callRoute("GET", "/scenarios");

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("Expected scenarios response");
    }

    const scenarios = response.data as AutomationScenarioCatalogEntry[];

    expect(scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "telegram-claim-linking.json",
          name: "Starter Telegram claim-linking flow",
        }),
        expect.objectContaining({
          relativePath: "telegram-pi-session.json",
          name: "Starter Telegram Pi session bootstrap + turns",
          relatedScriptKeys: expect.arrayContaining(["telegram-pi-session.ensure"]),
          relatedScriptPaths: expect.arrayContaining(["scripts/telegram-pi-session.ensure.sh"]),
          steps: expect.arrayContaining([
            expect.objectContaining({
              id: "telegram-pi",
              matchedScriptKeys: expect.arrayContaining(["telegram-pi-session.ensure"]),
              event: expect.objectContaining({
                source: "telegram",
                eventType: "message.received",
                payload: expect.objectContaining({
                  text: "/pi",
                  chatId: "chat-1",
                }),
              }),
            }),
          ]),
        }),
      ]),
    );
  });

  test("runs a starter automation simulator scenario", async () => {
    const response = await fragment.callRoute("POST", "/scenarios/run", {
      body: {
        path: "telegram-pi-session.json",
      },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error("Expected scenario run response");
    }

    const result = response.data as AutomationSimulationResult;

    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "Created Pi session: session-for-default::openai::gpt-5-mini",
      "Pi says hello from the linked Telegram session.",
      "Pi continues the original conversation.",
    ]);
    expect(result.transcript.totalCommandsRun).toBeGreaterThan(0);
    expect(result.finalState.identityBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "telegram-pi-session",
          key: "user-1",
          value: "session-for-default::openai::gpt-5-mini",
        }),
      ]),
    );
  });

  test("returns 400 for invalid scenario paths", async () => {
    const response = await fragment.callRoute("POST", "/scenarios/run", {
      body: {
        path: "../telegram-pi-session.json",
      },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error("Expected invalid path error response");
    }

    expect(response.status).toBe(400);
    expect(response.error).toMatchObject({
      code: "AUTOMATION_SCENARIO_PATH_INVALID",
      message: "Relative path cannot contain '.' or '..' segments.",
    });
  });

  test("returns 404 when the scenario file does not exist", async () => {
    const response = await fragment.callRoute("POST", "/scenarios/run", {
      body: {
        path: "missing-scenario.json",
      },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error("Expected missing scenario error response");
    }

    expect(response.status).toBe(404);
    expect(response.error).toMatchObject({
      code: "AUTOMATION_SCENARIO_NOT_FOUND",
    });
    expect(response.error.message).toContain("missing-scenario.json");
  });
});
