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
import { UPLOAD_PROVIDER_DATABASE } from "../../upload";
import { readyUploadFilesView, toUploadFileRecord } from "./replica";

const scenarioObjects = {
  AUTOMATIONS: (input) => new AutomationsObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const ORG_ID = "org-files";

function uploadObject(ctx: BackofficeScenarioContext) {
  return new BackofficeKernel(ctx.runtime.services).scoped(
    "UPLOAD",
    { kind: "org", orgId: ORG_ID },
    ctx.runtime.objects.upload,
  );
}

async function writeFile(
  ctx: BackofficeScenarioContext,
  file: { key: string; content: string; contentType: string },
) {
  const form = new FormData();
  form.set("provider", UPLOAD_PROVIDER_DATABASE);
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

async function deleteFile(ctx: BackofficeScenarioContext, key: string) {
  const url = new URL("https://backoffice.example/api/upload/files/by-key");
  url.searchParams.set("provider", UPLOAD_PROVIDER_DATABASE);
  url.searchParams.set("key", key);
  const response = await uploadObject(ctx).http.fetch(new Request(url, { method: "DELETE" }));
  assert(response.ok, await response.clone().text());
}

async function readExplorerTree(ctx: BackofficeScenarioContext) {
  const upload = ctx.lofi.upload.forOrg(ORG_ID);
  await upload.drain();
  const rows = await readScenarioReplicaView(
    readyUploadFilesView(upload.replica, UPLOAD_PROVIDER_DATABASE),
  );
  expect(upload.replica.getStatus()).toEqual({ phase: "caught-up", error: null });
  return createUploadFileTree(rows.map(toUploadFileRecord), {
    provider: UPLOAD_PROVIDER_DATABASE,
  }).entries.map((entry) => ({
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
          const upload = ctx.lofi.upload.forOrg(ORG_ID);
          expect(await readScenarioReplicaView(readyUploadFilesView(upload.replica, "r2"))).toEqual(
            [],
          );
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
      ],
    }),
  );
});
