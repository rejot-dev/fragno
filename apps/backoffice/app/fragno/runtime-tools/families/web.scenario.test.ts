import { expect, test, vi } from "vitest";

import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { STATE_FILE_MAX_BYTES } from "@fragno-dev/backoffice-api/v0/state";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

const scope: BackofficeContextScope = { kind: "org", orgId: "org-1", jurisdiction: null };
const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
// A temporary link that redirects to the file, like Drive's export links.
const exportLink = "https://drive.example/export?id=logo";

function download(url: string, path = "/workspace/downloads/logo.png") {
  return `async () => await web.download({ url: ${JSON.stringify(url)}, path: ${JSON.stringify(path)} })`;
}

/** A body that never declares its length, so only counting the stream can stop it. */
function unsizedBody(bytes: number) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  );
}

test("an agent downloads the file behind a temporary link into the workspace", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "download a file from a temporary link",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        web: fake.web({
          responses: {
            [exportLink]: () => Response.redirect("https://cdn.drive.example/logo.png", 302),
            "https://cdn.drive.example/logo.png": () => new Response(logo),
            "https://drive.example/inside": () => Response.redirect("https://127.0.0.1/admin", 302),
            "https://drive.example/expired": () => new Response("Gone", { status: 403 }),
            "https://drive.example/huge": () => unsizedBody(STATE_FILE_MAX_BYTES + 1),
          },
        }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert(
          "the redirect is followed and the file written, without credentials",
          async (ctx) => {
            await expect(ctx.runCodemode({ scope, code: download(exportLink) })).resolves.toEqual(
              expect.objectContaining({
                result: { path: "/workspace/downloads/logo.png", sizeBytes: logo.byteLength },
              }),
            );
            expect(ctx.fakes.web?.requests).toEqual([
              { url: exportLink, headers: {} },
              { url: "https://cdn.drive.example/logo.png", headers: {} },
            ]);
            expect(ctx.kernelActions).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ operation: BACKOFFICE_PERMISSION.web.download }),
                expect.objectContaining({
                  operation: BACKOFFICE_PERMISSION.upload.modify,
                  resource: { path: "/workspace/downloads/logo.png" },
                }),
              ]),
            );
          },
        ),
        then.files.bytes({
          orgId: scope.orgId,
          path: "/workspace/downloads/logo.png",
          content: logo,
        }),
        then.assert(
          "a redirect into the local network is refused before it is fetched",
          async (ctx) => {
            await expect(
              ctx.runCodemode({
                scope,
                code: download("https://drive.example/inside", "/workspace/downloads/inside.html"),
              }),
            ).rejects.toThrow(
              "WEB_DOWNLOAD_URL_REFUSED: https://127.0.0.1/admin is not a public https URL",
            );
            expect(ctx.fakes.web?.requests.map(({ url }) => url)).not.toContain(
              "https://127.0.0.1/admin",
            );
          },
        ),
        then.assert("an expired link reports the server's answer", async (ctx) => {
          await expect(
            ctx.runCodemode({
              scope,
              code: download("https://drive.example/expired", "/workspace/downloads/expired.png"),
            }),
          ).rejects.toThrow("WEB_DOWNLOAD_FAILED: https://drive.example/expired answered 403.");
        }),
        then.assert("a file larger than a workspace file holds is refused", async (ctx) => {
          await expect(
            ctx.runCodemode({
              scope,
              code: download("https://drive.example/huge", "/workspace/downloads/huge.bin"),
            }),
          ).rejects.toThrow(`WEB_DOWNLOAD_TOO_LARGE: https://drive.example/huge is larger than`);
        }),
        then.files.missing({ orgId: scope.orgId, path: "/workspace/downloads/inside.html" }),
        then.files.missing({ orgId: scope.orgId, path: "/workspace/downloads/expired.png" }),
        then.files.missing({ orgId: scope.orgId, path: "/workspace/downloads/huge.bin" }),
      ],
    }),
  );
});

test("the Node runtime refuses downloads, since it cannot keep them to public addresses", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "download on Node",
      objects: allLocalObjects,
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("the call reports downloads as unavailable", async (ctx) => {
          await expect(ctx.runCodemode({ scope, code: download(exportLink) })).rejects.toThrow(
            "Downloading from URLs is not available in the Node runtime",
          );
        }),
        then.files.missing({ orgId: scope.orgId, path: "/workspace/downloads/logo.png" }),
      ],
    }),
  );
});
