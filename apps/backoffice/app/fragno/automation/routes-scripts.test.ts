import { beforeEach, describe, expect, test } from "vitest";

import { InMemoryAdapter } from "@fragno-dev/db";

import type { AutomationWorkflowsService } from "./definition";
import {
  AUTOMATION_BINDINGS_MANIFEST_PATH,
  createAutomationFragment,
  createMinimalFileSystem,
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
    } as Awaited<ReturnType<typeof createMinimalFileSystem>>;

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

  test("loads scripts list even when one script is missing", async () => {
    const manifest = {
      version: 1,
      bindings: [
        {
          id: "present-script",
          source: "telegram",
          eventType: "messageReceived",
          enabled: true,
          script: {
            key: "present-script",
            name: "Present script",
            engine: "bash",
            path: "scripts/present.sh",
            version: 1,
            agent: null,
            env: {},
          },
        },
        {
          id: "missing-script",
          source: "telegram",
          eventType: "messageReceived",
          enabled: true,
          script: {
            key: "missing-script",
            name: "Missing script",
            engine: "bash",
            path: "scripts/missing.sh",
            version: 1,
            agent: null,
            env: {},
          },
        },
      ],
    } as const;

    const readFile = async (path: string) => {
      if (path === AUTOMATION_BINDINGS_MANIFEST_PATH) {
        return JSON.stringify(manifest);
      }

      if (path === "/workspace/automations/scripts/present.sh") {
        return "#!/usr/bin/env bash\necho ok";
      }

      throw new Error(`Unexpected path: ${path}`);
    };

    const fileSystem = {
      readFile,
      async readFileBuffer(path: string) {
        return new TextEncoder().encode(await readFile(path));
      },
      getAllPaths() {
        return [AUTOMATION_BINDINGS_MANIFEST_PATH, "/workspace/automations/scripts/present.sh"];
      },
    } as Awaited<ReturnType<typeof createMinimalFileSystem>>;

    const partialFragment = createAutomation({
      automationFileSystem: fileSystem,
    });

    const response = await partialFragment.callRoute("GET", "/scripts");

    expect(response.type).toBe("json");
    if (response.type === "json") {
      expect(response.data.length).toBe(2);
      expect(response.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "present-script",
            scriptLoadError: null,
          }),
          expect.objectContaining({
            key: "missing-script",
            scriptLoadError: expect.stringContaining(
              "Automation script for binding 'missing-script'",
            ),
          }),
        ]),
      );
    }
  });
});
