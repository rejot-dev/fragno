import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";
import { setScenarioAuthUserRole } from "@/fragno/automation/scenario-auth";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { buildBackofficeLoginPath } from "../../auth-navigation";
import { loader } from "./attachment-download";

const orgId = "org_123";
const downloadPath = "/backoffice/automations/org/fragno/integrations/telegram/attachment-download";

async function runAttachmentScenario(scenario: BackofficeScenarioDefinitionInput) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-telegram-attachment-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        ...scenario,
        options: { ...scenario.options, sqliteDataDirectory: directory },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function authenticateAttachmentUser(
  ctx: BackofficeScenarioContext,
  role: "admin" | "user",
  member: boolean,
) {
  const auth = ctx.runtime.objects.auth.singleton();
  const sessionCookie = ctx.vars.session;
  assert(typeof sessionCookie === "string");
  const session = await auth.http.fetch(
    new Request("https://example.com/api/auth/get-session", {
      headers: { cookie: sessionCookie },
    }),
  );
  assert(session.ok);
  const userId = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json())
    .user.id;
  if (member) {
    await auth.commands.applyScenarioFixture({
      members: [{ organizationId: orgId, userId, roles: ["member"] }],
    });
  }
  if (role === "admin") {
    await setScenarioAuthUserRole(ctx.runtime, { userId, role });
  }
  const exchange = await auth.http.fetch(
    new Request("https://example.com/api/auth/backoffice-token", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: "https://example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ selection: "preferred", organizationId: member ? orgId : null }),
    }),
  );
  assert(exchange.ok, await exchange.clone().text());
  const cookie = exchange.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  assert(cookie);
  return cookie;
}

async function downloadAttachment(ctx: BackofficeScenarioContext, query: string, cookie: string) {
  const url = new URL(`${downloadPath}?${query}`, "https://example.com");
  const request = new Request(url, { headers: cookie ? { cookie } : {} });
  return await loader({
    request,
    url,
    pattern:
      "/backoffice/automations/:scopeKind/:scopeId/integrations/telegram/attachment-download",
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    params: { scopeKind: "org", scopeId: "fragno" },
  });
}

describe("Telegram attachment download scenarios", () => {
  test("redirects anonymous users to login without downloading a file", async () => {
    await runAttachmentScenario({
      name: "Anonymous attachment requests do not reach Telegram",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: "fragno" })],
      steps: ({ then }) => [
        then.assert("login is required before file transport", async (ctx) => {
          const query = "fileId=file-1&kind=voice";
          const response = await downloadAttachment(ctx, query, "");
          assert.equal(response.status, 302);
          expect(response.headers.get("location")).toBe(
            `https://example.com${buildBackofficeLoginPath(`${downloadPath}?${query}`)}`,
          );
          assert(ctx.fakes.telegram);
          expect(ctx.fakes.telegram.downloadFileCalls).toEqual([]);
        }),
      ],
    });
  });

  for (const input of [
    {
      name: "downloads bytes with a file-path-derived filename",
      fileId: "file-1",
      filePath: "voice/message-1.ogg",
      bytes: new Uint8Array([0, 255, 1, 2]),
      query: "fileId=file-1&kind=voice",
      contentType: "audio/ogg",
      disposition: 'attachment; filename="message-1.ogg"',
    },
    {
      name: "prefers the original attachment filename",
      fileId: "file-1",
      filePath: "documents/file_123",
      bytes: new Uint8Array([7, 8, 9]),
      query: "fileId=file-1&kind=document&filename=Quarterly%20Report.pdf",
      contentType: "application/pdf",
      disposition: 'attachment; filename="Quarterly Report.pdf"',
    },
    {
      name: "falls back to attachment kind when file metadata has no path",
      fileId: "file/with spaces",
      filePath: null,
      bytes: new Uint8Array([1, 2, 3]),
      query: "fileId=file%2Fwith%20spaces&kind=voice",
      contentType: "audio/ogg",
      disposition: 'attachment; filename="file-with-spaces.ogg"',
    },
    {
      name: "serves inline disposition for attachment previews",
      fileId: "file-1",
      filePath: "photos/thumb.jpg",
      bytes: new Uint8Array([1, 2, 3, 4]),
      query: "fileId=file-1&kind=photo&disposition=inline",
      contentType: "image/jpeg",
      disposition: 'inline; filename="thumb.jpg"',
    },
  ]) {
    test(input.name, async () => {
      await runAttachmentScenario({
        name: input.name,
        fakes: ({ fake }) => ({
          telegram: fake.telegram({
            files: [
              {
                fileId: input.fileId,
                fileUniqueId: "unique-1",
                filePath: input.filePath,
                fileSize: input.bytes.byteLength,
                bytes: input.bytes,
              },
            ],
          }),
        }),
        setup: ({ given }) => [
          given.organization.exists({ id: orgId, slug: "fragno" }),
          given.telegram.configured({ orgId, botUsername: "fragno_bot" }),
        ],
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "attachment-admin@example.test",
            captureSessionCookieAs: "session",
          }),
          then.assert("authenticated UI requests use signed object transport", async (ctx) => {
            const cookie = await authenticateAttachmentUser(ctx, "admin", true);
            const response = await downloadAttachment(ctx, input.query, cookie);
            assert.equal(response.status, 200);
            expect(response.headers.get("content-type")).toBe(input.contentType);
            expect(response.headers.get("content-disposition")).toContain(input.disposition);
            expect(response.headers.get("content-length")).toBe(String(input.bytes.byteLength));
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(input.bytes);
            assert(ctx.fakes.telegram);
            expect(ctx.fakes.telegram.downloadFileCalls).toEqual([{ fileId: input.fileId }]);
          }),
        ],
      });
    });
  }

  test("returns 404 for users outside the organization without downloading", async () => {
    await runAttachmentScenario({
      name: "Attachment scope resolves only from authenticated memberships",
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: "fragno" })],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "attachment-outsider@example.test",
          captureSessionCookieAs: "session",
        }),
        then.assert(
          "non-members cannot select another organization's Telegram object",
          async (ctx) => {
            const cookie = await authenticateAttachmentUser(ctx, "user", false);
            await expect(
              downloadAttachment(ctx, "fileId=file-1&kind=voice", cookie),
            ).rejects.toMatchObject({ status: 404 });
            assert(ctx.fakes.telegram);
            expect(ctx.fakes.telegram.downloadFileCalls).toEqual([]);
          },
        ),
      ],
    });
  });

  test("organization members download attachments through the signed object transport", async () => {
    await runAttachmentScenario({
      name: "Attachment downloads authorize members with Telegram read permission",
      fakes: ({ fake }) => ({
        telegram: fake.telegram({
          files: [
            {
              fileId: "file-1",
              fileUniqueId: "unique-1",
              filePath: "voice/file.ogg",
              fileSize: 3,
              bytes: new Uint8Array([1, 2, 3]),
            },
          ],
        }),
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: orgId, slug: "fragno" }),
        given.telegram.configured({ orgId, botUsername: "fragno_bot" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "attachment-member@example.test",
          captureSessionCookieAs: "session",
        }),
        then.assert("members receive the attachment bytes", async (ctx) => {
          const cookie = await authenticateAttachmentUser(ctx, "user", true);
          const response = await downloadAttachment(ctx, "fileId=file-1&kind=voice", cookie);
          assert.equal(response.status, 200);
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
          assert(ctx.fakes.telegram);
          expect(ctx.fakes.telegram.downloadFileCalls).toEqual([{ fileId: "file-1" }]);
        }),
      ],
    });
  });
});
