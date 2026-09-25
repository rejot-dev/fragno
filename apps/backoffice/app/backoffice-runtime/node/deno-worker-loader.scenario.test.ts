import { expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { createNodeBackofficeRuntimeEnv } from "./node-runtime-env";

async function createDenoScenarioEnv() {
  return await createNodeBackofficeRuntimeEnv({
    denoExecutable: process.env.DENO_EXECUTABLE,
    env: {},
  });
}

test("Deno codemode denies operating system capabilities in a Backoffice scenario", async () => {
  const env = await createDenoScenarioEnv();

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Deno codemode denies operating system capabilities",
      env,
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.codemode.run({
          orgId: "org-1",
          code: `async () => {
            const denied = {};
            try { await Deno.readTextFile("/etc/hosts"); } catch (error) { denied.read = error.name; }
            try { await fetch("https://example.com"); } catch (error) { denied.net = error.name; }
            try { Deno.env.get("HOME"); } catch (error) { denied.env = error.name; }
            try { await new Deno.Command("/bin/echo", { args: ["unsafe"] }).output(); } catch (error) { denied.run = error.name; }
            return denied;
          }`,
        }),
        then.assert("all Deno host capabilities were denied", (ctx) => {
          expect(ctx.codemodeRuns.at(-1)?.result.result).toEqual({
            read: "NotCapable",
            net: "NotCapable",
            env: "NotCapable",
            run: "NotCapable",
          });
        }),
      ],
    }),
  );
});

test("Deno codemode cannot reach inherited host reference methods", async () => {
  const env = await createDenoScenarioEnv();

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Deno codemode host references expose only declared RPC methods",
      env,
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("Function constructor access is rejected", async (ctx) => {
          await expect(
            ctx.runCodemode({
              orgId: "org-1",
              code: `async () => {
                const getter = await __dispatchers.store.__lookupGetter__("__proto__");
                const createFunction = await getter.constructor("return globalThis.process");
                return await createFunction();
              }`,
            }),
          ).rejects.toThrow("DENO_CODEMODE_RPC_HOST_METHOD_NOT_FOUND:__lookupGetter__");
        }),
      ],
    }),
  );
});

test("malformed Deno wire values fail one codemode run without crashing Node", async () => {
  const env = await createDenoScenarioEnv();

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "malformed Deno wire values remain request-scoped failures",
      env,
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        then.assert("a malformed bigint frame is rejected", async (ctx) => {
          await expect(
            ctx.runCodemode({
              orgId: "org-1",
              code: `async () => {
                self.postMessage({
                  version: 1,
                  type: "complete",
                  ok: true,
                  value: { kind: "bigint", value: "not-a-bigint" },
                });
                await new Promise(() => {});
              }`,
              timeout: 5_000,
            }),
          ).rejects.toThrow("DENO_CODEMODE_RPC_INVALID_WIRE_VALUE:bigint");
        }),
        when.codemode.run({
          orgId: "org-1",
          label: "run valid codemode after malformed wire input",
          code: `async () => ({ nodeProcessSurvived: true })`,
        }),
        then.assert("the Node process continues serving codemode", (ctx) => {
          expect(ctx.codemodeRuns.at(-1)?.result.result).toEqual({ nodeProcessSurvived: true });
        }),
      ],
    }),
  );
});
