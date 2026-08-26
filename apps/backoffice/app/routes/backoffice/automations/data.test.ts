import { beforeEach, describe, expect, test, vi } from "vitest";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";

const { createBackofficeFileSystemMock } = vi.hoisted(() => ({
  createBackofficeFileSystemMock: vi.fn(),
}));

vi.mock("@/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/files")>();
  return {
    ...actual,
    createBackofficeFileSystem: createBackofficeFileSystemMock,
  };
});

import { loadAutomationScriptSource } from "./data.server";

const mockContext = { get: () => ({ runtime: { objects: {} }, env: {} }) } as never;
const verifiedRequestAuthority = {
  role: "user" as const,
  organizationId: "acme-org",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
};
const orgExecution = createBackofficeUserExecution({
  scope: { kind: "org", orgId: "acme-org" },
  userId: "user-1",
  verifiedRequestAuthority,
});
const projectExecution = createBackofficeUserExecution({
  scope: { kind: "project", orgId: "acme-org", projectId: "project-1" },
  userId: "user-1",
  verifiedRequestAuthority,
});

beforeEach(() => {
  createBackofficeFileSystemMock.mockReset();
});

describe("automation backoffice workspace data", () => {
  test("reads visible static script source from org scope", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/static/automations/project-files-configure.workflow.js": "configure",
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationScriptSource({
      context: mockContext,
      execution: orgExecution,
      scriptId: "automation-script:static:project-files-configure.workflow.js",
    });

    expect(result).toEqual({
      script: "configure",
      scriptError: null,
    });
    expect(fileSystem.readFileCalls).toEqual([
      "/static/automations/project-files-configure.workflow.js",
    ]);
  });

  test("rejects org static script source from project scope", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/static/automations/project-files-configure.workflow.js": "configure",
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationScriptSource({
      context: mockContext,
      execution: projectExecution,
      scriptId: "automation-script:static:project-files-configure.workflow.js",
    });

    expect(result).toEqual({
      script: null,
      scriptError:
        "Automation script '/static/automations/project-files-configure.workflow.js' is not visible in project scope.",
    });
    expect(fileSystem.readFileCalls).toEqual([]);
  });

  test("rejects hidden system script source from org scope", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/system/automations/workspace-file-initialization.workflow.js": "initialize",
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationScriptSource({
      context: mockContext,
      execution: orgExecution,
      scriptId: "automation-script:system:workspace-file-initialization.workflow.js",
    });

    expect(result).toEqual({
      script: null,
      scriptError:
        "Automation script '/system/automations/workspace-file-initialization.workflow.js' is not visible in org scope.",
    });
    expect(fileSystem.readFileCalls).toEqual([]);
  });

  test("reads the selected script source only when the user opens it", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/workspace/automations/lazy.sh": 'echo "lazy"',
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationScriptSource({
      context: mockContext,
      execution: orgExecution,
      scriptId: "automation-script:workspace:lazy.sh",
    });

    expect(result).toEqual({
      script: 'echo "lazy"',
      scriptError: null,
    });
    expect(fileSystem.readFileCalls).toEqual(["/workspace/automations/lazy.sh"]);
  });
});

function createStubAutomationFileSystem(files: Record<string, string>) {
  const directories = new Set<string>([
    "/",
    "/system",
    "/system/automations",
    "/workspace",
    "/workspace/automations",
  ]);

  for (const filePath of Object.keys(files)) {
    const segments = filePath.split("/").filter(Boolean);
    let current = "";

    for (const segment of segments.slice(0, -1)) {
      current += `/${segment}`;
      directories.add(current);
    }
  }

  const readFileCalls: string[] = [];
  const readdirCalls: string[] = [];
  const fs = {
    async readFile(path: string) {
      readFileCalls.push(path);
      const content = files[path];
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
    async readFileBuffer(path: string) {
      return new TextEncoder().encode(await this.readFile(path));
    },
    async readdir(path: string) {
      readdirCalls.push(path);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();

      for (const directory of directories) {
        if (directory === path || !directory.startsWith(prefix)) {
          continue;
        }
        const child = directory.slice(prefix.length).split("/")[0];
        if (child) {
          names.add(child);
        }
      }

      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) {
          continue;
        }
        const child = filePath.slice(prefix.length).split("/")[0];
        if (child) {
          names.add(child);
        }
      }

      return [...names].sort();
    },
    async stat(path: string) {
      return {
        isFile: Object.hasOwn(files, path),
        isDirectory: directories.has(path),
        isSymbolicLink: false,
        mode: Object.hasOwn(files, path) ? 0o644 : 0o755,
        size: files[path]?.length ?? 0,
        mtime: new Date(0),
      };
    },
    resolvePath(base: string, child: string) {
      return `${base.replace(/\/$/u, "")}/${child}`;
    },
    getAllPaths() {
      return [...directories, ...Object.keys(files)].sort();
    },
  };

  return { fs, readFileCalls, readdirCalls };
}
