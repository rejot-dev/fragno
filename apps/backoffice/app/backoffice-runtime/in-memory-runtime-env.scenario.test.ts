import { expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

test("in-memory codemode returns host-realm values through a Backoffice scenario", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "in-memory codemode returns host-realm values",
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.codemode.run({
          orgId: "org-1",
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
