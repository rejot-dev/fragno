import { assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createUploadFileTree } from "@/file-collection/create-upload-file-tree";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { readScenarioReplicaView } from "@/fragno/lofi/scenario-replica-database";

import { AutomationsObject } from "../../../../workers/automations-object";
import { UploadObject } from "../../../../workers/upload-object";
import { readyUploadFilesView, toUploadFileRecord } from "./replica";

const scenarioObjects = {
  AUTOMATIONS: (input) => new AutomationsObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const ORG_ID = "org-files";

function uploadObject(ctx: BackofficeScenarioContext) {
  return new BackofficeKernel(ctx.runtime.services).scoped(
    "UPLOAD",
    { kind: "org", orgId: ORG_ID, jurisdiction: null },
    ctx.runtime.objects.upload,
  );
}

async function writeFile(
  ctx: BackofficeScenarioContext,
  file: { key: string; content: string; contentType: string },
) {
  const form = new FormData();
  form.set("fileKey", file.key);
  form.set(
    "file",
    new File([file.content], file.key.split("/").at(-1)!, { type: file.contentType }),
  );
  const response = await uploadObject(ctx).http.fetch(
    new Request("https://backoffice.example/api/upload/files", { method: "POST", body: form }),
  );
  assert(response.ok, await response.clone().text());
}

/** Sends a file through an upload session; a batch upload waits for its commit to publish. */
async function uploadFile(
  ctx: BackofficeScenarioContext,
  file: { key: string; content: string; publicationMode: "immediate" | "batch" },
) {
  const upload = uploadObject(ctx).http;
  const created = await upload.fetch(
    new Request("https://backoffice.example/api/upload/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileKey: file.key,
        filename: file.key.split("/").at(-1)!,
        sizeBytes: new TextEncoder().encode(file.content).byteLength,
        contentType: "text/markdown",
        publicationMode: file.publicationMode,
      }),
    }),
  );
  assert(created.ok, await created.clone().text());
  const { uploadId } = (await created.json()) as { uploadId: string };
  const stored = await upload.fetch(
    new Request(`https://backoffice.example/api/upload/uploads/${uploadId}/content`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: file.content,
    }),
  );
  assert(stored.ok, await stored.clone().text());
  if (file.publicationMode === "batch") {
    const committed = await upload.fetch(
      new Request("https://backoffice.example/api/upload/files/commit-prepared", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: [{ kind: "write", uploadId }] }),
      }),
    );
    assert(committed.ok, await committed.clone().text());
  }
}

async function deleteFile(ctx: BackofficeScenarioContext, key: string) {
  const url = new URL("https://backoffice.example/api/upload/files/by-key");
  url.searchParams.set("key", key);
  const response = await uploadObject(ctx).http.fetch(new Request(url, { method: "DELETE" }));
  assert(response.ok, await response.clone().text());
}

async function readExplorerTree(ctx: BackofficeScenarioContext) {
  const upload = ctx.lofi.upload.forOrg(ORG_ID);
  await upload.drain();
  const rows = await readScenarioReplicaView(readyUploadFilesView(upload.replica));
  expect(upload.replica.getStatus()).toEqual({ phase: "caught-up", error: null });
  return createUploadFileTree(rows.map(toUploadFileRecord)).entries.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    ...(entry.kind === "file" ? { sizeBytes: entry.sizeBytes } : {}),
  }));
}

test("the Files explorer lists the ready files and folders of the Upload replica", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Files explorer reads the Upload replica",
      objects: scenarioObjects,
      steps: ({ then }) => [
        then.assert("upload files and a folder, then delete one file", async (ctx) => {
          await writeFile(ctx, {
            key: "notes/plan.md",
            content: "# Plan",
            contentType: "text/markdown",
          });
          await writeFile(ctx, {
            key: "notes/old.md",
            content: "Old",
            contentType: "text/markdown",
          });
          await writeFile(ctx, {
            key: "reports/q1.csv",
            content: "month,total\njan,3",
            contentType: "text/csv",
          });
          await writeFile(ctx, {
            key: "drafts/.fragno/dir-marker",
            content: "",
            contentType: "application/x.fragno-directory-marker",
          });
          await deleteFile(ctx, "notes/old.md");
        }),
        then.assert("the replica shows what remains", async (ctx) => {
          expect(await readExplorerTree(ctx)).toEqual([
            { kind: "directory", path: "drafts" },
            { kind: "directory", path: "notes" },
            { kind: "file", path: "notes/plan.md", sizeBytes: 6 },
            { kind: "directory", path: "reports" },
            { kind: "file", path: "reports/q1.csv", sizeBytes: 17 },
          ]);
        }),
        then.assert("a file uploaded later appears after the next sync", async (ctx) => {
          await writeFile(ctx, {
            key: "notes/next.md",
            content: "Next",
            contentType: "text/markdown",
          });
          expect(await readExplorerTree(ctx)).toContainEqual({
            kind: "file",
            path: "notes/next.md",
            sizeBytes: 4,
          });
        }),
        then.assert("the replica follows a file that uploads replace", async (ctx) => {
          const planSize = async () =>
            (await readExplorerTree(ctx)).find((entry) => entry.path === "notes/plan.md")
              ?.sizeBytes;
          await uploadFile(ctx, {
            key: "notes/plan.md",
            content: "# Plan, v2",
            publicationMode: "immediate",
          });
          assert((await planSize()) === 10);
          await uploadFile(ctx, {
            key: "notes/plan.md",
            content: "# Plan, v3!",
            publicationMode: "immediate",
          });
          assert((await planSize()) === 11);
          await uploadFile(ctx, {
            key: "notes/plan.md",
            content: "# Plan, committed",
            publicationMode: "batch",
          });
          assert((await planSize()) === 17);
          await deleteFile(ctx, "notes/plan.md");
          expect(await planSize()).toBeUndefined();
        }),
      ],
    }),
  );
});
