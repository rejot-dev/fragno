import { beforeEach, describe, expect, test, vi } from "vitest";

const { createOrgFileSystemMock, requireBackofficeContextMock } = vi.hoisted(() => ({
  createOrgFileSystemMock: vi.fn(),
  requireBackofficeContextMock: vi.fn(),
}));

vi.mock("@/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/files")>();
  return {
    ...actual,
    createOrgFileSystem: createOrgFileSystemMock,
  };
});

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { loadAutomationScriptSource, loadAutomationWorkspaceData } from "./data";

const mockContext = { get: () => ({ runtime: { objects: {} }, env: {} }) } as never;
const request = new Request("https://backoffice.test/automations");

beforeEach(() => {
  createOrgFileSystemMock.mockReset();
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
  test("shows filesystem scripts from both roots", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/system/automations/router.cm.js": "async () => true",
      "/workspace/automations/router.cm.js": "async () => true",
      "/workspace/automations/unbound.sh": 'echo "unbound"',
      "/workspace/automations/workflow.workflow.js":
        "defineWorkflow({ name: 'x' }, async () => {})",
    });
    createOrgFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationWorkspaceData({
      request,
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result.scriptsError).toBeNull();
    expect(result.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automation-script:system:router.cm.js",
          key: "router.cm",
          layer: "system",
          readOnly: true,
          path: "router.cm.js",
          enabled: true,
        }),
        expect.objectContaining({
          id: "automation-script:workspace:router.cm.js",
          key: "router.cm",
          layer: "workspace",
          readOnly: false,
          path: "router.cm.js",
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
    expect(fileSystem.readFileCalls).toEqual([]);
  });

  test("reads the selected script source only when the user opens it", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/workspace/automations/lazy.sh": 'echo "lazy"',
    });
    createOrgFileSystemMock.mockResolvedValue(fileSystem.fs);

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
