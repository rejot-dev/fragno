import { assert, expect, test, vi } from "vitest";

import type { FileLink } from "@fragno-dev/backoffice-api/v0/upload";
import { packTar, unpackTar, type TarEntry } from "modern-tar";
import { matchPath } from "react-router";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { action, loader } from "./file-links";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const ORG_SCOPE = { kind: "org", orgId: "org-1" } as const;

async function createLink(
  ctx: BackofficeScenarioContext,
  tool: "createDownloadLink" | "createUploadLink",
  path: string,
) {
  const run = await ctx.runCodemode({
    scope: ORG_SCOPE,
    code: `async () => await upload.${tool}(${JSON.stringify({ path })})`,
    assertToolCalls: [`upload.${tool}`],
  });
  return run.result as FileLink;
}

// Request bodies need ArrayBuffer-backed bytes, so the packed archive is copied once.
async function tar(entries: TarEntry[]) {
  return new Uint8Array(await packTar(entries));
}

/** Sends a request the way a sandbox's curl reaches the public file-link route. */
async function sendToLink(ctx: BackofficeScenarioContext, url: string, init?: RequestInit) {
  const request = new Request(url, init);
  const match = matchPath("/api/file-links/:scopeKind/:scopeId/:provider/*", new URL(url).pathname);
  assert(match, `${url} is not a file-link route`);
  const args = {
    request,
    url: new URL(url),
    pattern: match.pattern.path,
    params: match.params,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
  try {
    return request.method === "GET" ? await loader(args) : await action(args);
  } catch (thrown) {
    if (thrown instanceof Response) {
      return thrown;
    }
    throw thrown;
  }
}

test("a sandbox pulls a workspace folder and pushes its results back through file links", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "File links move workspace folders in and out of a sandbox",
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("folder links round-trip files through tar archives", async (ctx) => {
          const state = createRuntimeStateBackend({
            runtime: ctx.runtime.services,
            kernel: new BackofficeKernel(ctx.runtime.services),
            execution: createBackofficeSystemExecution(ORG_SCOPE),
          });
          await state.writeFile("/workspace/data/input.csv", "a,b\n1,2\n");
          await state.writeFileBytes("/workspace/data/raw/blob.bin", new Uint8Array([0, 255, 7]));
          await state.writeFile("/workspace/notes.md", "not in the folder");

          const download = await createLink(ctx, "createDownloadLink", "/workspace/data/");
          assert(download.format === "tar");
          expect(download).toMatchObject({ glob: "/workspace/data/**", root: "/workspace/data/" });
          const archive = await sendToLink(ctx, download.url);
          assert.equal(archive.status, 200, await archive.clone().text());
          const pulled = await unpackTar(new Uint8Array(await archive.arrayBuffer()));
          expect(pulled.map(({ header, data }) => [header.name, data])).toEqual([
            ["input.csv", new TextEncoder().encode("a,b\n1,2\n")],
            ["raw/blob.bin", new Uint8Array([0, 255, 7])],
          ]);

          const upload = await createLink(ctx, "createUploadLink", "/workspace/results/");
          assert(upload.format === "tar");
          const pushed = await sendToLink(ctx, upload.url, {
            method: "PUT",
            body: await tar([
              { header: { name: "./summary.md", size: 7 }, body: "# Done\n" },
              { header: { name: "./charts/", size: 0, type: "directory" } },
              { header: { name: "./charts/sales.json", size: 2 }, body: "[]" },
            ]),
          });
          assert.equal(pushed.status, 200, await pushed.clone().text());
          await expect(state.readFile("/workspace/results/summary.md")).resolves.toBe("# Done\n");
          await expect(state.readFile("/workspace/results/charts/sales.json")).resolves.toBe("[]");
          const listed = await ctx.runtime.objects.upload
            .forOrg("org-1")
            .http.fetch(
              new Request(
                "https://upload.internal/api/upload/files/by-key?provider=database&key=results/summary.md",
              ),
            );
          expect(await listed.json()).toMatchObject({ contentType: "text/markdown" });

          const singleFile = await createLink(ctx, "createUploadLink", "/workspace/notes.md");
          assert(singleFile.format === "file");
          const replaced = await sendToLink(ctx, singleFile.url, {
            method: "PUT",
            headers: { "content-length": "7" },
            body: "updated",
          });
          assert.equal(replaced.status, 200, await replaced.clone().text());
          await expect(state.readFile("/workspace/notes.md")).resolves.toBe("updated");

          const readOnly = await sendToLink(ctx, download.url, {
            method: "PUT",
            body: await tar([{ header: { name: "input.csv", size: 1 }, body: "x" }]),
          });
          assert.equal(readOnly.status, 403);
          await expect(state.readFile("/workspace/data/input.csv")).resolves.toBe("a,b\n1,2\n");

          const otherOrg = await sendToLink(
            ctx,
            download.url.replace("/org/org-1/", "/org/org-2/"),
          );
          assert.equal(otherOrg.status, 403);

          const escaped = await sendToLink(
            ctx,
            download.url.replace(/\/[^/]+\/archive\.tar$/u, "/..%2F..%2Ffiles"),
          );
          assert.equal(escaped.status, 404);
          assert.equal(await escaped.text(), "File link not found.");
        }),
      ],
    }),
  );
});
