import { afterAll, assert, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createDatabaseStorageAdapter } from "@fragno-dev/upload/storage/db";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import {
  createUploadFragment,
  uploadFragmentDefinition,
  uploadSchema,
  type StorageAdapter,
} from "@fragno-dev/upload";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";

import {
  fetchPublishedMarketplaceArtifactFile,
  loadPublishedMarketplaceArtifactExplorer,
} from "./artifact-files.server";

const manifest = {
  listingId: "system#daily-report",
  slug: "daily-report",
  listingStatus: "published" as const,
  uploadName: "marketplace-test-upload",
  versions: ["2.0.0", "1.0.0"],
};

type ArtifactSeedFile = {
  fileKey: string;
  contentType: string;
  content: string;
};

const files: ArtifactSeedFile[] = [
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

const schemaExtractionStorage: StorageAdapter = {
  name: "database",
  capabilities: {
    directUpload: false,
    multipartUpload: false,
    signedDownload: false,
    proxyUpload: true,
  },
  resolveStorageKey: ({ provider, fileKey }) => `${provider}/${fileKey}`,
  initUpload: async ({ provider, fileKey }) => ({
    strategy: "proxy",
    storageKey: `${provider}/${fileKey}`,
    expiresAt: new Date("2027-01-01T00:01:00.000Z"),
  }),
  deleteObject: async () => {},
};

const buildUploadTest = () =>
  buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 2 })
    .withFragmentFactory(
      "upload",
      uploadFragmentDefinition,
      ({ adapter }) =>
        createUploadFragment(
          {
            storage: createDatabaseStorageAdapter({
              databaseAdapter: adapter,
              providerName: "database",
            }),
          },
          { databaseAdapter: adapter, mountRoute: "/api/upload" },
        ),
      { config: { storage: schemaExtractionStorage } },
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

describe("Marketplace artifact files", () => {
  test("builds the explorer from Upload metadata without reading file content", async () => {
    const { objects, requests } = await createUploadObjects();
    const result = await loadPublishedMarketplaceArtifactExplorer({
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
      provider: "database",
      filename: "README.md",
      status: "ready",
    });
  });

  test("rejects artifact trees larger than one Upload page", async () => {
    const overflowFiles = Array.from({ length: 501 }, (_, index) =>
      createFile(`2.0.0/generated/file-${index}.txt`, "text/plain", `${index}`),
    );
    const { objects, requests } = await createUploadObjects({ additionalFiles: overflowFiles });
    const result = await loadPublishedMarketplaceArtifactExplorer({
      manifest,
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      requestedVersion: "2.0.0",
    });

    expect(result).toEqual({
      state: "error",
      message: "Upload file tree exceeded its 1-page retrieval limit.",
    });
    assert(requests.length === 1);
  }, 30_000);

  test("rejects artifact exploration for an unpublished manifest", async () => {
    const { objects, requests } = await createUploadObjects();
    const result = await loadPublishedMarketplaceArtifactExplorer({
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
    const response = await fetchPublishedMarketplaceArtifactFile({
      manifest,
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      path: "/artifact/README.md",
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
    const response = await fetchPublishedMarketplaceArtifactFile({
      manifest,
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      path: "/artifact/2.0.0/../private.txt",
    });

    assert(response.status === 400);
    assert(requests.length === 0);
  });

  test("rejects files from an unpublished artifact manifest", async () => {
    const { objects, requests } = await createUploadObjects();
    const response = await fetchPublishedMarketplaceArtifactFile({
      manifest: { ...manifest, listingStatus: "draft" },
      objects,
      request: new Request("https://backoffice.test/marketplace/daily-report"),
      path: "/artifact/2.0.0/README.md",
    });

    assert(response.status === 404);
    assert(requests.length === 0);
  });
});

async function createUploadObjects(
  options: { additionalFiles?: readonly ArtifactSeedFile[] } = {},
): Promise<{
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

  for (const file of [...files, ...(options.additionalFiles ?? [])]) {
    const form = new FormData();
    form.set("provider", "database");
    form.set("fileKey", file.fileKey);
    form.set(
      "file",
      new File([file.content], file.fileKey.split("/").at(-1) ?? "artifact", {
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
          return uploadObject;
        },
      },
    } as unknown as BackofficeObjectRegistry,
  };
}

async function readStoredFile(fileKey: string) {
  const fileUow = uploadTest.fragments.upload.db
    .createUnitOfWork("read-marketplace-artifact-file")
    .forSchema(uploadSchema)
    .findFirst("file", (builder) =>
      builder.whereIndex("idx_file_provider_key", (expression) =>
        expression.and(expression("provider", "=", "database"), expression("key", "=", fileKey)),
      ),
    );
  await fileUow.executeRetrieve();
  return (await fileUow.retrievalPhase)[0];
}

function createFile(fileKey: string, contentType: string, content: string): ArtifactSeedFile {
  return { fileKey, contentType, content };
}
