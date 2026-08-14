import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, createFragmentTestFetcher } from "@fragno-dev/test";

import { uploadFragmentDefinition } from "../definition";
import { uploadRoutes } from "../routes";
import { createFilesystemStorageAdapter } from "../storage/fs";
import { createUploadHelpers } from "./helpers";

const TEST_BASE_URL = "http://upload-file-edits.test";

describe("server-side upload file edits", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-file-edits-"));
  const storage = createFilesystemStorageAdapter({ rootDir });
  const provider = storage.name;
  const testSetup = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withDbRoundtripGuard({ maxRoundtrips: 3 })
    .withFragment(
      "upload",
      instantiate(uploadFragmentDefinition).withConfig({ storage }).withRoutes(uploadRoutes),
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
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterAll(async () => {
    await testSetup.test.cleanup();
    await fs.rm(rootDir, { recursive: true, force: true });
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
