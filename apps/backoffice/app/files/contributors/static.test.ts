import { describe, expect, test } from "vitest";

import {
  STATIC_FILE_CONTENT,
  STATIC_FILE_MOUNT_POINT,
  createSystemFilesContext,
  staticFileContributor,
  staticFileMount,
} from "@/files";

const createStaticFs = (
  staticFileArtifacts: () => Record<string, string> | Promise<Record<string, string>>,
) => {
  const fs = staticFileContributor.createFileSystem?.(
    createSystemFilesContext({
      execution: {
        actor: { type: "system", id: "system" },
        scope: { kind: "org", orgId: "org_123" },
      },
      staticFileArtifacts,
    }),
  );
  if (!fs || "fs" in fs || fs instanceof Promise) {
    throw new Error("Expected static filesystem.");
  }
  return fs;
};

describe("static file contributor", () => {
  test("exposes the /static mount metadata", async () => {
    expect(staticFileMount).toMatchObject({
      id: "static",
      kind: "static",
      mountPoint: "/static",
      readOnly: true,
      persistence: "persistent",
    });
    expect(staticFileContributor).toMatchObject(staticFileMount);
  });

  test("renders and reads the built-in /static docs pack", async () => {
    const entries = await staticFileContributor.readdirWithFileTypes?.(STATIC_FILE_MOUNT_POINT);
    expect(await staticFileContributor.readFile?.(`${STATIC_FILE_MOUNT_POINT}/SYSTEM.md`)).toEqual(
      STATIC_FILE_CONTENT["SYSTEM.md"],
    );

    expect(entries?.map((entry) => entry.name)).toEqual(expect.arrayContaining(["SYSTEM.md"]));
    expect(staticFileContributor.getAllPaths?.()).toEqual(
      expect.arrayContaining([
        "/static",
        ...Object.keys(STATIC_FILE_CONTENT).map((path) => `/static/${path}`),
      ]),
    );
  });

  test("does not load codemode artifacts for unrelated static files", async () => {
    const fs = createStaticFs(() => {
      throw new Error("codemode unavailable");
    });

    await expect(fs.readFile("/static/SYSTEM.md")).resolves.toEqual(
      STATIC_FILE_CONTENT["SYSTEM.md"],
    );
    await expect(fs.readdir("/static")).resolves.toEqual(
      expect.arrayContaining(["SYSTEM.md", "codemode"]),
    );
    await expect(fs.readFile("/static/codemode/system.d.ts")).rejects.toThrow(
      "codemode unavailable",
    );
  });

  test("loads codemode artifacts only for codemode paths", async () => {
    const fs = createStaticFs(() => ({ "codemode/system.d.ts": "declare const ok: true;" }));

    await expect(fs.readFile("/static/codemode/system.d.ts")).resolves.toBe(
      "declare const ok: true;",
    );
    await expect(fs.readdir("/static/codemode")).resolves.toEqual(["system.d.ts"]);
  });
});
