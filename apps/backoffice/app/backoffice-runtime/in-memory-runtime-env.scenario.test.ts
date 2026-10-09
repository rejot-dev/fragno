import { expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { InMemoryApiObject } from "../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../workers/apps.do";
import { InMemoryAuthObject } from "../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../workers/automations.do";
import { InMemoryFormsObject } from "../../workers/forms.do";
import { InMemoryMcpObject } from "../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../workers/telegram.do";
import { InMemoryUploadObject } from "../../workers/upload.do";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
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
            result: { logged: true, nested: { value: 1 } },
            logs: [],
            workflowDefinition: undefined,
            toolCalls: [],
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
