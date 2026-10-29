import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { BackofficeUiRenderer } from "@fragno-private/backoffice-ui/renderer";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { FileScopeProvider, LinkableScopesProvider } from "@/components/backoffice/file-scope";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { action as uploadWorkspaceFile } from "@/routes/api/files-scoped-workspace";
import { MarkdownText } from "@/routes/backoffice/agents/session-detail/message-content";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { ApiObject } from "../../../../workers/api-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { FormsObject } from "../../../../workers/forms-object";
import { OtpObject } from "../../../../workers/otp-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";
import { loader as downloadLoader } from "./download";
import { loader as explorerPathLoader } from "./explorer-path";
import { loader as previewLoader } from "./preview";
import { filesPreviewPath } from "./scope";

const downloadFile = behindBackofficeLayout(downloadLoader);
const exploreFile = behindBackofficeLayout(explorerPathLoader);
const previewFile = behindBackofficeLayout(previewLoader);

const scenarioObjects = {
  MCP: null,
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  OTP: (input) => new OtpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
const imagePath = "/workspace/screenshots/dashboard #1.png";
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="4" height="4"/></svg>';
const scope: BackofficeResolvedScope = {
  kind: "org",
  organization: { id: "org-images", slug: "image-team", jurisdiction: null },
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

test("private workspace files flow through session Markdown and generated UI without exposing other scopes or active content", async () => {
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
            {
              path: "/workspace/diagram.svg",
              bytes: new TextEncoder().encode(svg),
              type: "image/svg+xml",
            },
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
                <FileScopeProvider scope={scope}>
                  <MarkdownText
                    text={`Here is the result:\n\n![Dashboard preview](${encodeURI(imagePath).replaceAll("#", "%23")})`}
                  />
                </FileScopeProvider>
              </MemoryRouter>,
            );
            const generated = generatedImage(imagePath);
            assert(generated.kind === "valid", JSON.stringify(generated));
            const interfaceMarkup = renderToStaticMarkup(
              <MemoryRouter>
                <FileScopeProvider scope={scope}>
                  <BackofficeUiRenderer ui={generated.value.$ui} />
                </FileScopeProvider>
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
              <FileScopeProvider scope={scope}>
                <BackofficeUiRenderer ui={unsafe.value.$ui} />
              </FileScopeProvider>,
            );
            // A path read from state is checked as the image renders, before it can become a source.
            assert.include(unsafeMarkup, "Image cannot show its data");
            assert.notInclude(unsafeMarkup, "<img");
          },
        ),
        then.assert("link the file paths an agent mentions to the Files explorer", async (ctx) => {
          const message = [
            `Saved the [screenshot](${encodeURI(imagePath).replaceAll("#", "%23")}).`,
            "The notes are in `/workspace/notes/plan.md`, see /workspace/notes/plan.md:12 and `/workspace/notes/plan.md:3`.",
            "Ignore https://external.example/workspace/notes/plan.md and /workspace/../secret.md.",
            "Read the [docs](https://external.example/docs).",
            "```sh\ncat /workspace/notes/script.md\n```",
          ].join("\n\n");
          const markup = renderToStaticMarkup(
            <MemoryRouter>
              <FileScopeProvider scope={scope}>
                <MarkdownText text={message} />
              </FileScopeProvider>
            </MemoryRouter>,
          );
          const links = [...markup.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(
            ([, href, content]) => ({ href, content }),
          );
          expect(links).toEqual([
            {
              href: "/backoffice/files/org/image-team/workspace/screenshots/dashboard%20%231.png",
              content: "screenshot",
            },
            {
              href: "/backoffice/files/org/image-team/workspace/notes/plan.md",
              content: expect.stringContaining(">/workspace/notes/plan.md</code>"),
            },
            {
              href: "/backoffice/files/org/image-team/workspace/notes/plan.md",
              content: "/workspace/notes/plan.md:12",
            },
            {
              href: "/backoffice/files/org/image-team/workspace/notes/plan.md",
              content: expect.stringContaining(">/workspace/notes/plan.md:3</code>"),
            },
          ]);
          // External links keep Streamdown's confirmation before leaving Backoffice.
          assert.include(markup, 'data-streamdown="link"');
          assert.include(markup, "cat /workspace/notes/script.md");

          const fileUrl = new URL(links[0]!.href, "https://backoffice.example");
          const request = new Request(fileUrl, { headers: { cookie: ctx.vars.cookie as string } });
          const explorer = await exploreFile({
            request,
            url: fileUrl,
            pattern: "/backoffice/files/:scopeKind/:scopeId/*",
            params: {
              scopeKind: "org",
              scopeId: "image-team",
              "*": decodeURIComponent(fileUrl.pathname.split("/").slice(5).join("/")),
            },
            context: createBackofficeRouterContextProvider(request, {
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              env: ctx.runtime.env as unknown as CloudflareEnv,
              ctx: {} as ExecutionContext,
            }),
          });
          assert(!(explorer instanceof Response));
          assert.equal(explorer.selectedPath, imagePath);

          // A file destination resolves only as a valid path in the scope, whatever wraps it.
          const destinations = renderToStaticMarkup(
            <MemoryRouter>
              <FileScopeProvider scope={scope}>
                <MarkdownText
                  text={[
                    `[![Preview](${encodeURI(imagePath).replaceAll("#", "%23")})](/workspace/notes/plan.md)`,
                    '<file-link path="/workspace/../../logout">Raw tag</file-link>',
                    "[Traversal](/workspace/../logout)",
                    "![Traversal](/workspace/../logout) ![Malformed](/workspace/bad%FF.png)",
                    // A page's source opens as the rendered page; only workspace sources are pages.
                    "[Report](/workspace/reports/ops.page.js) `/static/examples/demo.page.js`",
                  ].join("\n\n")}
                />
              </FileScopeProvider>
            </MemoryRouter>,
          );
          assert.include(
            destinations,
            `src="${filesPreviewPath(scope, imagePath).replaceAll("&", "&amp;")}"`,
          );
          assert.include(
            destinations,
            'href="/backoffice/files/org/image-team/workspace/notes/plan.md"',
          );
          assert.include(
            destinations,
            'href="/backoffice/dashboard/org/image-team/pages/reports/ops"',
          );
          assert.include(
            destinations,
            'href="/backoffice/files/org/image-team/static/examples/demo.page.js"',
          );
          assert.include(destinations, "Raw tag");
          assert.notInclude(destinations, "logout");
          assert.notInclude(destinations, "bad%FF");
          assert.notInclude(destinations, "blocked");
          assert.equal(destinations.match(/<img/g)?.length, 1);
          assert.equal(destinations.match(/Image unavailable/g)?.length, 2);

          // Without a scope there is no Files explorer to open, so mentions stay plain.
          const unscoped = renderToStaticMarkup(<MarkdownText text={message} />);
          assert.notInclude(unscoped, "/backoffice/files");
          assert.include(unscoped, "/workspace/notes/plan.md:12");

          // A link names another scope before the path; it opens there when the page can link to it.
          const crossScope = [
            "[Finance](/org:org-finance/workspace/pages/finance.page.js)",
            "[Elsewhere](/org:org-unknown/workspace/pages/finance.page.js)",
            "[Traversal](/org:org-finance/workspace/../logout)",
            "Bare /org:org-finance/workspace/notes/bare.md:3 and `/org:org-finance/workspace/notes/code.md`.",
            "![Chart](/org:org-finance/workspace/charts/q3.png) ![Hidden](/org:org-unknown/workspace/a.png)",
          ].join("\n\n");
          const resolveScope = (target: BackofficeContextScope): BackofficeResolvedScope | null =>
            target.kind === "org" && target.orgId === "org-finance"
              ? {
                  kind: "org",
                  organization: { id: "org-finance", slug: "finance", jurisdiction: null },
                }
              : null;
          const scoped = renderToStaticMarkup(
            <MemoryRouter>
              <LinkableScopesProvider resolveScope={resolveScope}>
                <FileScopeProvider scope={scope}>
                  <MarkdownText text={crossScope} />
                </FileScopeProvider>
              </LinkableScopesProvider>
            </MemoryRouter>,
          );
          expect(
            [...scoped.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(
              ([, href, content]) => ({ href, content }),
            ),
          ).toEqual([
            {
              href: "/backoffice/dashboard/org/finance/pages/pages/finance",
              content: "Finance",
            },
            {
              href: "/backoffice/files/org/finance/workspace/notes/bare.md",
              content: "/org:org-finance/workspace/notes/bare.md:3",
            },
            {
              href: "/backoffice/files/org/finance/workspace/notes/code.md",
              content: expect.stringContaining("/org:org-finance/workspace/notes/code.md</code>"),
            },
            {
              href: "/backoffice/files/org/finance/workspace/charts/q3.png",
              content: expect.stringContaining("Open in Files"),
            },
          ]);
          assert.include(scoped, "Elsewhere");
          assert.notInclude(scoped, "logout");
          // Images resolve in the scope they name, and never request the scoped path itself.
          assert.include(
            scoped,
            'src="/backoffice/files/org/finance/preview?path=%2Fworkspace%2Fcharts%2Fq3.png"',
          );
          assert.notInclude(scoped, 'src="/org:');
        }),
        then.assert(
          "sandbox declared SVGs and deny anonymous and cross-scope reads, traversal, and other markup",
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
            // An SVG previews inline, but opened directly it may not run its scripts.
            const svgPreview = await requestPreview(
              "/workspace/diagram.svg",
              "org",
              "image-team",
              cookie,
            );
            assert.equal(svgPreview.headers.get("content-type"), "image/svg+xml");
            assert.equal(svgPreview.headers.get("x-content-type-options"), "nosniff");
            assert.include(svgPreview.headers.get("content-security-policy")!, "sandbox");
            assert.include(
              svgPreview.headers.get("content-security-policy")!,
              "default-src 'none'",
            );
            assert.equal(await svgPreview.text(), svg);
            await expect(requestPreview(imagePath, "org", "image-team", "")).rejects.toMatchObject({
              status: 302,
            });
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
