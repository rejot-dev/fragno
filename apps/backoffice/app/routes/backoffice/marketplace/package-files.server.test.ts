import { afterAll, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { createUploadFragment, uploadFragmentDefinition, uploadSchema } from "@fragno-dev/upload";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { seedReadyUploadFiles } from "@/file-collection/ready-upload-files.test-support";

import {
  fetchPublishedMarketplacePackageFile,
  loadPublishedMarketplacePackageExplorer,
} from "./package-files.server";

const manifest = {
  listingId: "system#daily-report",
  slug: "daily-report",
  listingStatus: "published" as const,
  uploadName: "marketplace-test-upload",
  versions: ["2.0.0", "1.0.0"],
};

type PackageSeedFile = {
  fileKey: string;
  contentType: string;
  content: string;
};

const files: PackageSeedFile[] = [
  createFile("README.md", "text/markdown", "# Package overview"),
  createFile("2.0.0/README.md", "text/markdown", "# Version 2"),
  createFile(
    "2.0.0/automations/daily-report.workflow.js",
    "text/javascript",
    "defineWorkflow({ name: 'daily' })",
  ),
  createFile("2.0.0/automations/helpers.js", "text/javascript", "export const helper = true"),
  createFile("1.0.0/README.md", "text/markdown", "# Version 1"),
  createFile(
    "1.0.0/automations/old.workflow.js",
    "text/javascript",
    "defineWorkflow({ name: 'old' })",
  ),
  createFile("3.0.0/private.txt", "text/plain", "unpublished"),
];

const uploadConfig = { maxFileBytes: 1024 * 1024 };

const buildUploadTest = () =>
  buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 2 })
    .withFragmentFactory(
      "upload",
      uploadFragmentDefinition,
      ({ adapter }) =>
        createUploadFragment(uploadConfig, { databaseAdapter: adapter, mountRoute: "/api/upload" }),
      { config: uploadConfig },
    )
    .build();

type UploadTest = Awaited<ReturnType<typeof buildUploadTest>>;

let uploadTest: UploadTest;

beforeAll(async () => {
  uploadTest = await buildUploadTest();
}, 30_000);

beforeEach(async () => {
  await uploadTest.test.resetDatabase();
});

afterAll(async () => {
  await uploadTest.test.cleanup();
});

describe("Marketplace package files", () => {
  test("builds the explorer from Upload metadata without reading file content", async () => {
    const { objects, requests } = await createUploadObjects();
    const result = await loadPublishedMarketplacePackageExplorer({
      manifest,
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      requestedVersion: "2.0.0",
    });

    assert(result.state === "ready");
    const paths = result.fileTree.entries.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "README.md",
        "2.0.0",
        "2.0.0/README.md",
        "2.0.0/automations/daily-report.workflow.js",
        "1.0.0/README.md",
      ]),
    );
    expect(paths).not.toContain("3.0.0/private.txt");
    assert(result.selectedVersion === "2.0.0");
    assert(requests.every(({ pathname }) => pathname === "/api/upload/files"));

    const storedFile = await readStoredFile("2.0.0/README.md");
    expect(storedFile).toMatchObject({
      key: "2.0.0/README.md",
      filename: "README.md",
      status: "ready",
    });
  });

  test("paginates shared listing storage across Upload metadata pages", async () => {
    const { objects, requests } = await createUploadObjects();
    await seedReadyUploadFiles(uploadTest.fragments.upload.db, {
      fileKeys: Array.from({ length: 501 }, (_, index) => `2.0.0/generated/file-${index}.txt`),
    });
    const result = await loadPublishedMarketplacePackageExplorer({
      manifest,
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      requestedVersion: "2.0.0",
    });

    assert(result.state === "ready");
    expect(result.fileTree.entries.map((entry) => entry.path)).toContain(
      "2.0.0/generated/file-500.txt",
    );
    assert(requests.length === 2);
  });

  test("rejects package exploration for an unpublished manifest", async () => {
    const { objects, requests } = await createUploadObjects();
    const result = await loadPublishedMarketplacePackageExplorer({
      manifest: { ...manifest, listingStatus: "draft" },
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      requestedVersion: "2.0.0",
    });

    expect(result).toEqual({
      state: "unavailable",
      message: "This Marketplace listing has no published files.",
    });
    assert(requests.length === 0);
  });

  test("streams one selected file through the lazy content route", async () => {
    const { objects, requests } = await createUploadObjects();
    const response = await fetchPublishedMarketplacePackageFile({
      manifest,
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      path: "/package/README.md",
    });

    assert(response.status === 200);
    assert(response.headers.get("content-type") === "text/markdown");
    assert((await response.text()) === "# Package overview");
    assert(requests.length === 1);
    assert(requests[0]?.pathname === "/api/upload/files/by-key/content");
    assert(requests[0]?.searchParams.get("key") === "README.md");
  });

  test("rejects invalid file paths before requesting Upload content", async () => {
    const { objects, requests } = await createUploadObjects();
    const response = await fetchPublishedMarketplacePackageFile({
      manifest,
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      path: "/package/2.0.0/../private.txt",
    });

    assert(response.status === 400);
    assert(requests.length === 0);
  });

  test("rejects files from an unpublished listing storage", async () => {
    const { objects, requests } = await createUploadObjects();
    const response = await fetchPublishedMarketplacePackageFile({
      manifest: { ...manifest, listingStatus: "draft" },
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      path: "/package/2.0.0/README.md",
    });

    assert(response.status === 404);
    assert(requests.length === 0);
  });
});

async function createUploadObjects(): Promise<{
  objects: BackofficeObjectRegistry;
  requests: URL[];
}> {
  const requests: URL[] = [];
  const uploadObject = {
    fetch: async (request: Request) => {
      requests.push(new URL(request.url));
      return uploadTest.fragments.upload.fragment.handler(request);
    },
  };

  for (const file of files) {
    const form = new FormData();
    form.set("fileKey", file.fileKey);
    form.set(
      "file",
      new File([file.content], file.fileKey.split("/").at(-1) ?? "package", {
        type: file.contentType,
      }),
    );
    const response = await uploadObject.fetch(
      new Request("https://upload.test/api/upload/files", { method: "POST", body: form }),
    );
    assert(response.ok);
    const created = (await response.json()) as { fileKey: string; status: string };
    expect(created).toMatchObject({ fileKey: file.fileKey, status: "ready" });
  }
  requests.length = 0;

  return {
    requests,
    objects: {
      upload: {
        forName: (name: string) => {
          expect(name).toBe(manifest.uploadName);
          return { commands: {}, http: uploadObject };
        },
      },
    } as unknown as BackofficeObjectRegistry,
  };
}

async function readStoredFile(fileKey: string) {
  const fileUow = uploadTest.fragments.upload.db
    .createUnitOfWork("read-marketplace-package-file")
    .forSchema(uploadSchema)
    .findFirst("file", (builder) =>
      builder.whereIndex("idx_file_key", (expression) => expression("key", "=", fileKey)),
    );
  await fileUow.executeRetrieve();
  return (await fileUow.retrievalPhase)[0];
}

function createFile(fileKey: string, contentType: string, content: string): PackageSeedFile {
  return { fileKey, contentType, content };
}
