import { expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { ApiObject } from "../../workers/api-object";
import { AppInstallationsObject } from "../../workers/app-installations-object";
import { AppsObject } from "../../workers/apps-object";
import { AuthObject } from "../../workers/auth-object";
import { AutomationsObject } from "../../workers/automations-object";
import { BillingObject } from "../../workers/billing-object";
import { CodemodeObject } from "../../workers/codemode-object";
import { FormsObject } from "../../workers/forms-object";
import { McpObject } from "../../workers/mcp-object";
import { TelegramObject } from "../../workers/telegram-object";
import { UploadObject } from "../../workers/upload-object";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: (input) => new McpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

test("in-memory codemode returns host-realm values through a Backoffice scenario", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "in-memory codemode returns host-realm values",
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.codemode.run({
          scope: { kind: "org", orgId: "org-1" },
          code: `async () => ({ logged: true, nested: { value: 1 } })`,
        }),
        then.assert("the result is detached into the host realm", ({ codemodeRuns }) => {
          const result = codemodeRuns.at(-1)?.result;
          if (!result) {
            throw new Error("In-memory codemode scenario did not record a result.");
          }
          expect(result).toEqual({
            runId: expect.any(String),
            errorDetails: null,
            result: { logged: true, nested: { value: 1 } },
            logs: [],
            workflowDefinition: undefined,
            toolCalls: [],
            modules: {},
          });
          expect(Object.getPrototypeOf(result.result)).toBe(Object.prototype);
          expect(Object.getPrototypeOf((result.result as { nested: object }).nested)).toBe(
            Object.prototype,
          );
        }),
      ],
    }),
  );
});
