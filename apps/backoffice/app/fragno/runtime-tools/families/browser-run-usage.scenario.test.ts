import { expect, test, vi } from "vitest";

import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

const scope: BackofficeContextScope = { kind: "org", orgId: "org-1", jurisdiction: null };
const period = new Date().toISOString().slice(0, 7);
const docs = "https://docs.acme.example/api/authentication";

test("an agent reads and captures a page, and the organization pays for the browser time", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Browser Run usage",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        browserRun: fake.browserRun({
          pages: { [docs]: "# Authentication\n\nSend your secret key as a bearer token." },
          browserMsUsed: 219.6,
        }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("the page is read as Markdown and captured as a screenshot", async (ctx) => {
          await expect(
            ctx.runCodemode({
              scope,
              code: `async () => await web.extract({ action: "markdown", input: { url: ${JSON.stringify(docs)} } })`,
            }),
          ).resolves.toEqual(
            expect.objectContaining({
              result: {
                action: "markdown",
                result: "# Authentication\n\nSend your secret key as a bearer token.",
              },
            }),
          );
          await expect(
            ctx.runCodemode({
              scope,
              code: `async () => await cloudflare.browserRunCapture({ action: "screenshot", input: { url: ${JSON.stringify(docs)} } })`,
            }),
          ).resolves.toEqual(
            expect.objectContaining({
              result: expect.objectContaining({ contentType: "image/png" }),
            }),
          );
          expect(ctx.fakes.browserRun?.requests.map(({ action }) => action)).toEqual([
            "markdown",
            "screenshot",
          ]);
        }),
        // Each Quick Action's 219.6 ms, in whole milliseconds.
        then.billing.tracker({
          scope,
          period,
          meter: "browser-run.time",
          quantity: "440",
          eventCount: "2",
        }),
      ],
    }),
  );
});
