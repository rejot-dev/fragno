import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { action } from "./files-scoped-workspace";

test("workspace uploads preserve streaming bytes and resolve MIME metadata for new files and rewrites", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Streaming workspace writes share scoped state",
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "workspace-uploader@example.test",
          captureSessionCookieAs: "sessionCookie",
        }),
        then.assert(
          "authenticated streaming uploads preserve bytes and content type",
          async (ctx) => {
            const auth = ctx.runtime.objects.auth.singleton();
            const session = await auth.http.fetch(
              new Request("https://backoffice.example/api/auth/get-session", {
                headers: { cookie: ctx.vars.sessionCookie as string },
              }),
            );
            assert(session.ok);
            const { user } = (await session.json()) as { user: { id: string } };
            await auth.commands.applyScenarioFixture({
              members: [
                {
                  organizationId: "org-1",
                  userId: user.id,
                  roles: ["owner"],
                },
              ],
            });
            const exchange = await auth.http.fetch(
              new Request("https://backoffice.example/api/auth/backoffice-token", {
                method: "POST",
                headers: {
                  cookie: ctx.vars.sessionCookie as string,
                  origin: "https://backoffice.example",
                  "content-type": "application/json",
                },
                body: JSON.stringify({ selection: "required", organizationId: "org-1" }),
              }),
            );
            assert(exchange.ok, await exchange.clone().text());
            const cookie = exchange.headers
              .getSetCookie()
              .map((header) => header.split(";", 1)[0])
              .join("; ");
            assert(cookie);
            const kernel = new BackofficeKernel(ctx.runtime.services);
            async function uploadWorkspaceFile(
              path: string,
              contentLength: string | null,
              contentType: string | null,
            ) {
              const url = new URL("https://backoffice.example/api/files/org/org-1/workspace");
              url.searchParams.set("path", path);
              const request = new Request(url, {
                method: "PUT",
                headers: {
                  cookie,
                  ...(contentType === null ? {} : { "content-type": contentType }),
                  ...(contentLength === null ? {} : { "content-length": contentLength }),
                },
                body: new Blob([new Uint8Array([65, 0, 255, 10])]),
              });
              return action({
                request,
                url,
                pattern: "/api/files/:scopeKind/:scopeId/workspace",
                params: { scopeKind: "org", scopeId: "org-1" },
                context: createBackofficeRouterContextProvider(request, {
                  runtime: ctx.runtime.services,
                  kernel,
                  env: ctx.runtime.env as unknown as CloudflareEnv,
                  ctx: {} as ExecutionContext,
                }),
              });
            }

            async function assertWorkspaceFileContentType(path: string, contentType: string) {
              const query = new URLSearchParams({
                provider: "database",
                key: path.slice("/workspace/".length),
              });
              const upload = ctx.runtime.objects.upload.forOrg("org-1").http;
              const metadata = await upload.fetch(
                new Request(`https://upload.internal/api/upload/files/by-key?${query}`),
              );
              assert(metadata.ok);
              expect(await metadata.json()).toMatchObject({
                contentType,
                sizeBytes: 4,
                metadata: null,
              });
              const download = await upload.fetch(
                new Request(`https://upload.internal/api/upload/files/by-key/content?${query}`),
              );
              assert(download.ok);
              assert.equal(download.headers.get("content-type"), contentType);
              expect(new Uint8Array(await download.arrayBuffer())).toEqual(
                new Uint8Array([65, 0, 255, 10]),
              );
            }

            const uploaded = await uploadWorkspaceFile(
              "/workspace/streamed.txt",
              "4",
              "text/plain",
            );
            assert.equal(uploaded.status, 200);
            const state = createRuntimeStateBackend({
              runtime: ctx.runtime.services,
              kernel,
              execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
            });
            await expect(state.readFileBytes("/workspace/streamed.txt")).resolves.toEqual(
              new Uint8Array([65, 0, 255, 10]),
            );
            await assertWorkspaceFileContentType("/workspace/streamed.txt", "text/plain");
            for (const { path, requestedContentType, expectedContentType } of [
              {
                path: "/workspace/readme.md",
                requestedContentType: null,
                expectedContentType: "text/markdown",
              },
              {
                path: "/workspace/config.json",
                requestedContentType: null,
                expectedContentType: "application/json",
              },
              {
                path: "/workspace/image.PNG",
                requestedContentType: null,
                expectedContentType: "image/png",
              },
              {
                path: "/workspace/unknown.custom",
                requestedContentType: null,
                expectedContentType: "application/octet-stream",
              },
              {
                path: "/workspace/generic.md",
                requestedContentType: "application/octet-stream",
                expectedContentType: "text/markdown",
              },
              {
                path: "/workspace/generic.json",
                requestedContentType: "binary/octet-stream",
                expectedContentType: "application/json",
              },
              {
                path: "/workspace/parameterized.md",
                requestedContentType: "Application/Octet-Stream; charset=binary",
                expectedContentType: "text/markdown",
              },
              {
                path: "/workspace/explicit.json",
                requestedContentType: "text/plain",
                expectedContentType: "text/plain",
              },
            ]) {
              const uploaded = await uploadWorkspaceFile(path, "4", requestedContentType);
              assert.equal(uploaded.status, 200);
              await assertWorkspaceFileContentType(path, expectedContentType);
            }
            const customPath = "/workspace/custom.json";
            const customContentType = "application/vnd.fragno.config+json";
            const customUpload = await uploadWorkspaceFile(customPath, "4", customContentType);
            assert.equal(customUpload.status, 200);
            for (const contentType of [null, "application/octet-stream", "binary/octet-stream"]) {
              const rewritten = await uploadWorkspaceFile(customPath, "4", contentType);
              assert.equal(rewritten.status, 200);
              await assertWorkspaceFileContentType(customPath, customContentType);
            }
            const explicitRewrite = await uploadWorkspaceFile(customPath, "4", "text/plain");
            assert.equal(explicitRewrite.status, 200);
            await assertWorkspaceFileContentType(customPath, "text/plain");
            const deleted = await ctx.runtime.objects.upload.forOrg("org-1").http.fetch(
              new Request(
                "https://upload.internal/api/upload/files/by-key?provider=database&key=custom.json",
                {
                  method: "DELETE",
                },
              ),
            );
            assert(deleted.ok);
            const recreated = await uploadWorkspaceFile(
              customPath,
              "4",
              "application/octet-stream",
            );
            assert.equal(recreated.status, 200);
            await assertWorkspaceFileContentType(customPath, "application/json");

            const legacyForm = new FormData();
            legacyForm.set("provider", "database");
            legacyForm.set("fileKey", "legacy.json");
            legacyForm.set("filename", "legacy.json");
            legacyForm.set(
              "file",
              new Blob([new Uint8Array([65, 0, 255, 10])], { type: "application/octet-stream" }),
            );
            const legacy = await ctx.runtime.objects.upload.forOrg("org-1").http.fetch(
              new Request("https://upload.internal/api/upload/files", {
                method: "POST",
                body: legacyForm,
              }),
            );
            assert(legacy.ok);
            const repaired = await uploadWorkspaceFile("/workspace/legacy.json", "4", null);
            assert.equal(repaired.status, 200);
            await assertWorkspaceFileContentType("/workspace/legacy.json", "application/json");
            await expect(
              uploadWorkspaceFile("/workspace/missing-length.txt", null, "text/plain"),
            ).rejects.toMatchObject({ status: 411 });
            await expect(
              uploadWorkspaceFile("/workspace/../outside.txt", "4", "text/plain"),
            ).rejects.toMatchObject({ status: 400 });
            await expect(state.exists("/workspace/missing-length.txt")).resolves.toBe(false);
          },
        ),
      ],
    }),
  );
});
