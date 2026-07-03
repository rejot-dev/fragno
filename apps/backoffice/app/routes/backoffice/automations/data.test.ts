import { beforeEach, describe, expect, test, vi } from "vitest";

const { createBackofficeFileSystemMock, requireBackofficeContextMock } = vi.hoisted(() => ({
  createBackofficeFileSystemMock: vi.fn(),
  requireBackofficeContextMock: vi.fn(),
}));

vi.mock("@/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/files")>();
  return {
    ...actual,
    createBackofficeFileSystem: createBackofficeFileSystemMock,
  };
});

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { loadAutomationScriptSource, loadAutomationWorkspaceData } from "./data.server";

const mockContext = { get: () => ({ runtime: { objects: {} }, env: {} }) } as never;
const request = new Request("https://backoffice.test/automations");

beforeEach(() => {
  createBackofficeFileSystemMock.mockReset();
  requireBackofficeContextMock.mockReset();
  requireBackofficeContextMock.mockResolvedValue({
    actor: {
      type: "user",
      id: "user-1",
      userId: "user-1",
      organizationIds: ["acme-org"],
    },
    scope: { kind: "org", orgId: "acme-org" },
  });
});

describe("automation backoffice workspace data", () => {
  test("shows org filesystem scripts from the workspace root", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/static/automations/project-files-configure.workflow.js":
        "defineWorkflow({ name: 'project-files-configure' }, async () => {})",
      "/system/automations/workspace-file-initialization.workflow.js":
        "defineWorkflow({ name: 'workspace-file-initialization' }, async () => {})",
      "/workspace/automations/custom.cm.js": "async () => true",
      "/workspace/automations/unbound.sh": 'echo "unbound"',
      "/workspace/automations/workflow.workflow.js":
        "defineWorkflow({ name: 'x' }, async () => {})",
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationWorkspaceData({
      request,
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result.scriptsError).toBeNull();
    expect(result.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automation-script:workspace:custom.cm.js",
          key: "custom.cm",
          layer: "workspace",
          readOnly: false,
          path: "custom.cm.js",
          enabled: true,
        }),
        expect.objectContaining({
          id: "automation-script:workspace:unbound.sh",
          key: "unbound",
          path: "unbound.sh",
          enabled: true,
        }),
        expect.objectContaining({
          id: "automation-script:workspace:workflow.workflow.js",
          path: "workflow.workflow.js",
          enabled: false,
        }),
      ]),
    );
    expect(result.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automation-script:static:project-files-configure.workflow.js",
          key: "project-files-configure.workflow",
          layer: "static",
          readOnly: true,
          path: "project-files-configure.workflow.js",
          enabled: false,
        }),
      ]),
    );
    expect(result.scripts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automation-script:system:workspace-file-initialization.workflow.js",
        }),
      ]),
    );
    expect(fileSystem.readFileCalls).toEqual([]);
  });

  test("shows project workspace scripts without org static scripts in project scope", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/static/automations/project-files-configure.workflow.js":
        "defineWorkflow({ name: 'project-files-configure' }, async () => {})",
      "/workspace/automations/project-only.cm.js": "async () => true",
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationWorkspaceData({
      request,
      context: mockContext,
      scope: { kind: "project", orgId: "acme-org", projectId: "project-1" },
    });

    expect(result.scripts).toEqual([
      expect.objectContaining({
        id: "automation-script:workspace:project-only.cm.js",
        layer: "workspace",
        readOnly: false,
        path: "project-only.cm.js",
      }),
    ]);
  });

  test("shows system scripts in system scope", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/static/automations/project-files-configure.workflow.js":
        "defineWorkflow({ name: 'project-files-configure' }, async () => {})",
      "/system/automations/workspace-file-initialization.workflow.js":
        "defineWorkflow({ name: 'workspace-file-initialization' }, async () => {})",
      "/workspace/automations/custom.cm.js": "async () => true",
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationWorkspaceData({
      request,
      context: mockContext,
      scope: { kind: "system" },
    });

    expect(result.scripts).toEqual([
      expect.objectContaining({
        id: "automation-script:system:workspace-file-initialization.workflow.js",
        key: "workspace-file-initialization.workflow",
        layer: "system",
        readOnly: true,
        path: "workspace-file-initialization.workflow.js",
        enabled: false,
      }),
    ]);
  });

  test("reads visible static script source from org scope", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/static/automations/project-files-configure.workflow.js": "configure",
    });
    createBackofficeFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationScriptSource({
      request,
      context: mockContext,
      orgId: "acme-org",
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
      request,
      context: mockContext,
      scope: { kind: "project", orgId: "acme-org", projectId: "project-1" },
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
      request,
      context: mockContext,
      orgId: "acme-org",
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
      request,
      context: mockContext,
      orgId: "acme-org",
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

  return { fs, readFileCalls };
}
