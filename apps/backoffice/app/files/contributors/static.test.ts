import { describe, expect, test } from "vitest";

import {
  BACKOFFICE_SYSTEM_ACTORS,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import {
  STATIC_FILE_CONTENT,
  STATIC_FILE_MOUNT_POINT,
  createSystemFilesContext,
  staticFileContributor,
  staticFileMount,
  systemFileContributor,
} from "@/files";

import type { FileContent } from "../interface";

const createStaticFs = (
  staticFileArtifacts: () => Record<string, string> | Promise<Record<string, string>>,
) => {
  const fs = staticFileContributor.createFileSystem?.(
    createSystemFilesContext({
      execution: {
        actors: BACKOFFICE_SYSTEM_ACTORS,
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

const staticContent = STATIC_FILE_CONTENT as Record<string, FileContent>;

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
    expect(
      await staticFileContributor.readFile?.(
        `${STATIC_FILE_MOUNT_POINT}/skills/generating-backoffice-uis/SKILL.md`,
      ),
    ).toEqual(staticContent["skills/generating-backoffice-uis/SKILL.md"]);

    expect(entries?.map((entry) => entry.name)).toEqual(expect.arrayContaining(["SYSTEM.md"]));
    expect(staticFileContributor.getAllPaths?.()).toEqual(
      expect.arrayContaining([
        "/static",
        ...Object.keys(STATIC_FILE_CONTENT).map((path) => `/static/${path}`),
      ]),
    );
  });

  test("shows system files only through system scope for interactive admins", () => {
    const systemScopeFileSystem = systemFileContributor.createFileSystem?.(
      createSystemFilesContext({
        execution: createBackofficeUserExecution({
          scope: { kind: "system" },
          userId: "admin-1",
          verifiedRequestAuthority: {
            role: "admin",
            organizationId: "org-1",
            expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          },
        }),
        staticFileArtifacts: () => ({}),
      }),
    );
    const orgScopeFileSystem = systemFileContributor.createFileSystem?.(
      createSystemFilesContext({
        execution: createBackofficeUserExecution({
          scope: { kind: "org", orgId: "org-1" },
          userId: "admin-1",
          verifiedRequestAuthority: {
            role: "admin",
            organizationId: "org-1",
            expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          },
        }),
        staticFileArtifacts: () => ({}),
      }),
    );

    expect(systemScopeFileSystem).not.toBeNull();
    expect(orgScopeFileSystem).toBeNull();
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
    await expect(fs.readFile("/static/codemode/system.d.ts")).resolves.toContain(
      "/static/codemode/providers/telegram.d.ts",
    );
    await expect(fs.readFile("/static/codemode/sources/mcp.d.ts")).rejects.toThrow(
      "codemode unavailable",
    );
  });

  test("loads organization-specific artifacts only for the codemode sources directory", async () => {
    const fs = createStaticFs(() => ({
      "codemode/sources/mcp.d.ts": "declare const ok: true;",
    }));

    await expect(fs.readFile("/static/codemode/sources/mcp.d.ts")).resolves.toBe(
      "declare const ok: true;",
    );
    await expect(fs.readdir("/static/codemode")).resolves.toEqual(
      expect.arrayContaining(["providers", "sources", "system.d.ts"]),
    );
  });
});
