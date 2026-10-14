import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { BackofficeUiRenderer } from "@/backoffice-ui/renderer";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import { FileImageScopeProvider } from "@/components/backoffice/file-image";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { action as uploadWorkspaceFile } from "@/routes/api/files-scoped-workspace";
import { MarkdownText } from "@/routes/backoffice/sessions/session-detail/message-content";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../../workers/otp.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { loader as downloadFile } from "./download";
import { loader as exploreFile } from "./explorer-path";
import { loader as previewFile } from "./preview";
import { filesPreviewPath } from "./scope";

const scenarioObjects = {
  MCP: null,
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
const imagePath = "/workspace/screenshots/dashboard #1.png";
const scope: BackofficeResolvedScope = {
  kind: "org",
  organization: { id: "org-images", slug: "image-team" },
};

function generatedImage(path: string) {
  return parseBackofficeUiResult({
    $ui: {
      version: 1,
      state: { path },
      spec: {
        root: "gallery",
        elements: {
          gallery: { type: "Grid", props: { columns: 2, gap: "md" }, children: ["image"] },
          image: {
            type: "Image",
            props: { path: { $state: "/path" }, alt: "Dashboard preview" },
            children: [],
          },
        },
      },
    },
  });
}

function imageSource(markup: string): string {
  const source = /<img[^>]+src="([^"]+)"/.exec(markup)?.[1];
  assert(source, markup);
  return source.replaceAll("&amp;", "&");
}

test("private workspace images flow through session Markdown and generated UI without exposing other scopes or active content", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Scoped session image previews",
      setup: ({ given }) => [
        given.organization.exists({ id: "org-images", slug: "image-team", name: "Image team" }),
        given.organization.exists({
          id: "org-private",
          slug: "private-team",
          name: "Private team",
        }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "image-viewer@example.test",
          captureSessionCookieAs: "sessionCookie",
        }),
        then.assert("authorize the viewer and persist binary workspace images", async (ctx) => {
          const auth = ctx.runtime.objects.auth.singleton();
          const session = await auth.http.fetch(
            new Request("https://backoffice.example/api/auth/get-session", {
              headers: { cookie: ctx.vars.sessionCookie as string },
            }),
          );
          assert(session.ok);
          const { user } = (await session.json()) as { user: { id: string } };
          ctx.vars.userId = user.id;
          await auth.commands.applyScenarioFixture({
            members: [{ organizationId: "org-images", userId: user.id, roles: ["owner"] }],
          });
          const exchange = await auth.http.fetch(
            new Request("https://backoffice.example/api/auth/backoffice-token", {
              method: "POST",
              headers: {
                cookie: ctx.vars.sessionCookie as string,
                origin: "https://backoffice.example",
                "content-type": "application/json",
              },
              body: JSON.stringify({ selection: "required", organizationId: "org-images" }),
            }),
          );
          assert(exchange.ok, await exchange.clone().text());
          const cookie = exchange.headers
            .getSetCookie()
            .map((header) => header.split(";", 1)[0])
            .join("; ");
          assert(cookie);
          ctx.vars.cookie = cookie;
          const kernel = new BackofficeKernel(ctx.runtime.services);
          for (const file of [
            { path: imagePath, bytes: png, type: "application/octet-stream" },
            {
              path: "/workspace/disguised.png",
              bytes: new TextEncoder().encode(
                '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
              ),
              type: "image/png",
            },
            {
              path: "/workspace/page.png",
              bytes: new TextEncoder().encode("<html><script>alert(1)</script></html>"),
              type: "image/png",
            },
            { path: "/workspace/empty.png", bytes: new Uint8Array(), type: "image/png" },
          ]) {
            const url = new URL("https://backoffice.example/api/files/org/org-images/workspace");
            url.searchParams.set("path", file.path);
            const request = new Request(url, {
              method: "PUT",
              headers: {
                cookie,
                "content-type": file.type,
                "content-length": String(file.bytes.length),
              },
              body: new Blob([file.bytes]),
            });
            const response = await uploadWorkspaceFile({
              request,
              url,
              pattern: "/api/files/:scopeKind/:scopeId/workspace",
              params: { scopeKind: "org", scopeId: "org-images" },
              context: createBackofficeRouterContextProvider(request, {
                runtime: ctx.runtime.services,
                kernel,
                env: ctx.runtime.env as unknown as CloudflareEnv,
                ctx: {} as ExecutionContext,
              }),
            });
            assert.equal(response.status, 200);
          }
        }),
        then.assert(
          "render both image surfaces and fetch their authenticated bytes",
          async (ctx) => {
            const markdown = renderToStaticMarkup(
              <MemoryRouter>
                <FileImageScopeProvider scope={scope}>
                  <MarkdownText
                    text={`Here is the result:\n\n![Dashboard preview](${encodeURI(imagePath).replaceAll("#", "%23")})`}
                  />
                </FileImageScopeProvider>
              </MemoryRouter>,
            );
            const generated = generatedImage(imagePath);
            assert(generated.kind === "valid", JSON.stringify(generated));
            const interfaceMarkup = renderToStaticMarkup(
              <MemoryRouter>
                <FileImageScopeProvider scope={scope}>
                  <BackofficeUiRenderer ui={generated.value.$ui} />
                </FileImageScopeProvider>
              </MemoryRouter>,
            );
            const kernel = new BackofficeKernel(ctx.runtime.services);
            for (const markup of [markdown, interfaceMarkup]) {
              const src = imageSource(markup);
              assert.equal(src, filesPreviewPath(scope, imagePath));
              assert.include(markup, 'alt="Dashboard preview"');
              assert.include(markup, 'loading="lazy"');
              const url = new URL(src, "https://backoffice.example");
              const request = new Request(url, { headers: { cookie: ctx.vars.cookie as string } });
              const args = {
                request,
                url,
                pattern: "/backoffice/files/:scopeKind/:scopeId/preview",
                params: { scopeKind: "org", scopeId: "image-team" },
                context: createBackofficeRouterContextProvider(request, {
                  runtime: ctx.runtime.services,
                  kernel,
                  env: ctx.runtime.env as unknown as CloudflareEnv,
                  ctx: {} as ExecutionContext,
                }),
              };
              const response = await previewFile(args);
              assert.equal(response.status, 200);
              assert.equal(response.headers.get("content-type"), "image/png");
              assert.equal(response.headers.get("content-disposition"), "inline");
              assert.equal(response.headers.get("cache-control"), "private, no-store");
              assert.equal(response.headers.get("x-content-type-options"), "nosniff");
              assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
              expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
              const download = await downloadFile(args);
              assert.include(download.headers.get("content-disposition")!, "attachment");
              expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);

              assert.include(markup, "dashboard #1.png");
              assert.include(markup, "Open in Files");
              const fileHref = /<a[^>]+href="([^"]+)"/.exec(markup)?.[1];
              assert.equal(
                fileHref,
                "/backoffice/files/org/image-team/workspace/screenshots/dashboard%20%231.png",
              );
              const fileUrl = new URL(fileHref!, "https://backoffice.example");
              const fileRequest = new Request(fileUrl, {
                headers: { cookie: ctx.vars.cookie as string },
              });
              const explorer = await exploreFile({
                request: fileRequest,
                url: fileUrl,
                pattern: "/backoffice/files/:scopeKind/:scopeId/*",
                params: {
                  scopeKind: "org",
                  scopeId: "image-team",
                  "*": decodeURIComponent(fileUrl.pathname.split("/").slice(5).join("/")),
                },
                context: createBackofficeRouterContextProvider(fileRequest, {
                  runtime: ctx.runtime.services,
                  kernel,
                  env: ctx.runtime.env as unknown as CloudflareEnv,
                  ctx: {} as ExecutionContext,
                }),
              });
              assert(!(explorer instanceof Response));
              assert.equal(explorer.selectedPath, imagePath);
              assert.equal(explorer.loadError, null);
            }
            const unavailable = renderToStaticMarkup(
              <BackofficeUiRenderer ui={generated.value.$ui} />,
            );
            assert.include(unavailable, "Image unavailable");
            assert.notInclude(unavailable, "<img");
            const unsafe = generatedImage("https://external.example/tracking.png");
            assert(unsafe.kind === "valid", JSON.stringify(unsafe));
            const unsafeMarkup = renderToStaticMarkup(
              <FileImageScopeProvider scope={scope}>
                <BackofficeUiRenderer ui={unsafe.value.$ui} />
              </FileImageScopeProvider>,
            );
            assert.include(unsafeMarkup, "Image unavailable");
            assert.notInclude(unsafeMarkup, "<img");
          },
        ),
        then.assert(
          "deny anonymous and cross-scope reads, traversal, and non-raster files",
          async (ctx) => {
            const kernel = new BackofficeKernel(ctx.runtime.services);
            async function requestPreview(
              path: string,
              scopeKind: string,
              scopeId: string,
              cookie: string,
            ) {
              const url = new URL(
                `https://backoffice.example/backoffice/files/${scopeKind}/${scopeId}/preview`,
              );
              url.searchParams.set("path", path);
              const request = new Request(url, { headers: { cookie } });
              return previewFile({
                request,
                url,
                pattern: "/backoffice/files/:scopeKind/:scopeId/preview",
                params: { scopeKind, scopeId },
                context: createBackofficeRouterContextProvider(request, {
                  runtime: ctx.runtime.services,
                  kernel,
                  env: ctx.runtime.env as unknown as CloudflareEnv,
                  ctx: {} as ExecutionContext,
                }),
              });
            }
            const cookie = ctx.vars.cookie as string;
            assert.equal((await requestPreview(imagePath, "org", "image-team", "")).status, 302);
            await expect(
              requestPreview(imagePath, "org", "private-team", cookie),
            ).rejects.toMatchObject({ status: 404 });
            await expect(
              requestPreview(imagePath, "user", "someone-else", cookie),
            ).rejects.toMatchObject({ status: 404 });
            await expect(
              requestPreview(imagePath, "system", "system", cookie),
            ).rejects.toMatchObject({ status: 404 });
            for (const path of [
              "/workspace/../secret.png",
              "/workspace/./secret.png",
              "/workspace//secret.png",
              "/workspace/secret\\file.png",
              "https://external.example/image.png",
              "/workspace/",
            ]) {
              await expect(requestPreview(path, "org", "image-team", cookie)).rejects.toMatchObject(
                { status: 400 },
              );
            }
            for (const path of [
              "/workspace/missing.png",
              "/system/private.png",
              "/unknown/image.png",
            ]) {
              await expect(requestPreview(path, "org", "image-team", cookie)).rejects.toMatchObject(
                { status: 404 },
              );
            }
            for (const path of [
              "/workspace/disguised.png",
              "/workspace/page.png",
              "/workspace/empty.png",
            ]) {
              await expect(requestPreview(path, "org", "image-team", cookie)).rejects.toMatchObject(
                { status: 415 },
              );
            }
          },
        ),
      ],
    }),
  );
});
