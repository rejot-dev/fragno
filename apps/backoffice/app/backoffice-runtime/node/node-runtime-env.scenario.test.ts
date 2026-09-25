import { expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { createNodeBackofficeRuntimeEnv } from "./node-runtime-env";

test("Node production codemode executes through Deno in a Backoffice scenario", async () => {
  const env = await createNodeBackofficeRuntimeEnv({
    denoExecutable: process.env.DENO_EXECUTABLE,
    env: {},
  });

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Node production codemode executes through Deno",
      env,
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.codemode.run({
          orgId: "org-1",
          label: "execute realm-detached Deno codemode",
          code: `async () => ({ runtime: "deno", nested: { safe: true } })`,
        }),
        then.assert("Deno returns host-realm codemode results", (ctx) => {
          const result = ctx.codemodeRuns.at(-1)?.result;
          if (!result) {
            throw new Error("Deno codemode scenario did not record a result.");
          }
          expect(result).toMatchObject({
            result: { runtime: "deno", nested: { safe: true } },
            logs: [],
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
