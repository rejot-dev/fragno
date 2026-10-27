import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, createFragmentTestFetcher } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../routes";
import { createUploadHelpers } from "./helpers";

const TEST_BASE_URL = "http://upload-helpers.test";

describe("upload client helpers against the fragment", async () => {
  const provider = "workspace";
  const testSetup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard(true)
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition)
        .withConfig({ maxFileBytes: 1024 * 1024 })
        .withRoutes(uploadRoutes),
    )
    .build();
  const server = testSetup.fragments.upload;
  const fetcher = createFragmentTestFetcher(server.fragment, { baseUrl: TEST_BASE_URL });
  const helpers = createUploadHelpers({
    buildUrl: (routePath) => `${TEST_BASE_URL}${server.fragment.mountRoute}${routePath}`,
    fetcher,
  });

  const readFile = async (fileKey: string) => {
    const response = await fetcher(
      `${TEST_BASE_URL}${server.fragment.mountRoute}/files/by-key/content?${new URLSearchParams({
        provider,
        key: fileKey,
      })}`,
    );
    assert(response.status === 200);
    return await response.text();
  };

  beforeEach(async () => {
    await testSetup.test.resetDatabase();
  });

  afterAll(async () => {
    await testSetup.test.cleanup();
  });

  it("deletes a file by key so reading it reports it gone", async () => {
    await helpers.applyEdits({
      provider,
      edits: [{ kind: "write", fileKey: "uploads/old.txt", content: "old" }],
    });

    await helpers.deleteFile("uploads/old.txt", { provider });

    const response = await fetcher(
      `${TEST_BASE_URL}${server.fragment.mountRoute}/files/by-key/content?${new URLSearchParams({
        provider,
        key: "uploads/old.txt",
      })}`,
    );
    assert(response.status === 410);
  });

  it("uploads a file, downloads it, and prepares a batch write that publishes on commit", async () => {
    const progress: number[] = [];
    const uploaded = await helpers.createUploadAndTransfer(
      new Blob(["report body"], { type: "text/plain" }),
      {
        provider,
        fileKey: "reports/q3.txt",
        onProgress: ({ bytesUploaded }) => progress.push(bytesUploaded),
      },
    );
    assert(uploaded.kind === "published");
    expect(uploaded.file).toMatchObject({ fileKey: "reports/q3.txt", sizeBytes: 11 });
    assert(progress.at(-1) === 11);
    const downloaded = await helpers.downloadFile("reports/q3.txt", { provider });
    assert((await downloaded.text()) === "report body");

    const prepared = await helpers.createUploadAndTransfer(new Blob(["next quarter"]), {
      provider,
      fileKey: "reports/q4.txt",
      publicationMode: "batch",
    });
    assert(prepared.kind === "prepared");
    await expect(helpers.downloadFile("reports/q4.txt", { provider })).rejects.toThrow(
      /response status 404/,
    );
    const committed = await fetcher(
      `${TEST_BASE_URL}${server.fragment.mountRoute}/files/commit-prepared`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [{ kind: "write", uploadId: prepared.write.uploadId }],
        }),
      },
    );
    assert(committed.status === 200);
    await expect(readFile("reports/q4.txt")).resolves.toBe("next quarter");
  });

  it("applies write, replace, and JSON operations through one client request", async () => {
    await helpers.applyEdits({
      provider,
      edits: [
        { kind: "write", fileKey: "src/config.ts", content: "export const enabled = false;" },
        { kind: "write", fileKey: "generated/config.json", content: '{"enabled":false}' },
      ],
    });

    const applied = await helpers.applyEdits({
      provider,
      edits: [
        {
          kind: "replace",
          fileKey: "src/config.ts",
          search: "false",
          replacement: "true",
        },
        {
          kind: "writeJson",
          fileKey: "generated/config.json",
          value: { enabled: true },
        },
        {
          kind: "write",
          fileKey: "generated/new.txt",
          content: "created on the server",
        },
      ],
    });

    assert(applied.totalChanged === 3);
    assert(applied.edits.every((edit) => edit.diff.length > 0));
    await expect(readFile("src/config.ts")).resolves.toBe("export const enabled = true;");
    await expect(readFile("generated/config.json")).resolves.toBe('{\n  "enabled": true\n}\n');
    await expect(readFile("generated/new.txt")).resolves.toBe("created on the server");
  });
});
