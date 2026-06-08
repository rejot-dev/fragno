import { beforeEach, describe, expect, test, vi } from "vitest";

const { createOrgFileSystemMock } = vi.hoisted(() => ({
  createOrgFileSystemMock: vi.fn(),
}));

vi.mock("@/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/files")>();
  return {
    ...actual,
    createOrgFileSystem: createOrgFileSystemMock,
  };
});

import { loadAutomationScriptSource, loadAutomationWorkspaceData } from "./data";

const mockContext = { get: () => ({ env: {} }) } as never;

beforeEach(() => {
  createOrgFileSystemMock.mockReset();
});

describe("automation backoffice workspace data", () => {
  test("shows filesystem scripts directly", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/starter/automations/scripts/router.cm.js": "async () => true",
      "/starter/automations/scripts/unbound.sh": 'echo "unbound"',
      "/starter/automations/scripts/workflow.workflow.js":
        "defineWorkflow({ name: 'x' }, async () => {})",
    });
    createOrgFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationWorkspaceData({
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result.scriptsError).toBeNull();
    expect(result.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workspace-script:scripts/router.cm.js",
          key: "router.cm",
          path: "scripts/router.cm.js",
          enabled: true,
        }),
        expect.objectContaining({
          id: "workspace-script:scripts/unbound.sh",
          key: "unbound",
          path: "scripts/unbound.sh",
          enabled: true,
        }),
        expect.objectContaining({
          id: "workspace-script:scripts/workflow.workflow.js",
          path: "scripts/workflow.workflow.js",
          enabled: false,
        }),
      ]),
    );
    expect(fileSystem.readFileCalls).toEqual([]);
  });

  test("reads the selected script source only when the user opens it", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/starter/automations/scripts/lazy.sh": 'echo "lazy"',
    });
    createOrgFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationScriptSource({
      context: mockContext,
      orgId: "acme-org",
      scriptId: "workspace-script:scripts/lazy.sh",
    });

    expect(result).toEqual({
      script: 'echo "lazy"',
      scriptError: null,
    });
    expect(fileSystem.readFileCalls).toEqual(["/starter/automations/scripts/lazy.sh"]);
  });
});

function createStubAutomationFileSystem(files: Record<string, string>) {
  const directories = new Set<string>(["/", "/workspace", "/starter/automations"]);

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
