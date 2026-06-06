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
  test("shows workspace scripts directly from the automation directory", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/workspace/automations/router.js": "async () => true",
      "/workspace/automations/scripts/recoverable.sh": 'echo "still here"',
      "/workspace/automations/telegram-claim-linking.workflow.js":
        "defineWorkflow({ name: 'x' }, async () => true)",
    });
    createOrgFileSystemMock.mockResolvedValue(fileSystem.fs);

    const result = await loadAutomationWorkspaceData({
      context: mockContext,
      orgId: "acme-org",
    });

    expect(result.scriptsError).toBeNull();
    expect(result.bindingsError).toBeNull();
    expect(result.bindings).toEqual([]);
    expect(result.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "workspace-script:router.js",
          key: "router",
          name: "Router",
          path: "router.js",
          version: null,
          bindingCount: 0,
          enabledBindingCount: 0,
          enabled: true,
        }),
        expect.objectContaining({
          id: "workspace-script:scripts/recoverable.sh",
          key: "recoverable",
          name: "Recoverable",
          path: "scripts/recoverable.sh",
          version: null,
          bindingCount: 0,
          enabledBindingCount: 0,
          enabled: true,
        }),
        expect.objectContaining({
          id: "workspace-script:telegram-claim-linking.workflow.js",
          key: "telegram-claim-linking.workflow",
          name: "Telegram Claim Linking Workflow",
          path: "telegram-claim-linking.workflow.js",
          version: null,
          bindingCount: 0,
          enabledBindingCount: 0,
          enabled: false,
        }),
      ]),
    );
    expect(fileSystem.readFileCalls).toEqual([]);
  });

  test("reads the selected script source only when the user opens it", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/workspace/automations/scripts/lazy.sh": 'echo "lazy"',
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
    expect(fileSystem.readFileCalls).toEqual(["/workspace/automations/scripts/lazy.sh"]);
  });
});

function createStubAutomationFileSystem(files: Record<string, string>) {
  const directories = new Set<string>(["/", "/workspace", "/workspace/automations"]);

  for (const filePath of Object.keys(files)) {
    const segments = filePath.split("/").filter(Boolean);
    let current = "";

    for (const segment of segments.slice(0, -1)) {
      current += `/${segment}`;
      directories.add(current);
    }
  }

  const listChildren = (path: string) => {
    const normalized = normalizeDirectory(path);
    const children = new Set<string>();

    for (const directoryPath of directories) {
      if (directoryPath === normalized.replace(/\/+$/, "")) {
        continue;
      }

      if (!directoryPath.startsWith(`${normalized}`)) {
        continue;
      }

      const remainder = directoryPath.slice(normalized.length);
      const nextSegment = remainder.split("/").filter(Boolean)[0];
      if (nextSegment) {
        children.add(nextSegment);
      }
    }

    for (const filePath of Object.keys(files)) {
      if (!filePath.startsWith(normalized)) {
        continue;
      }

      const remainder = filePath.slice(normalized.length);
      const nextSegment = remainder.split("/").filter(Boolean)[0];
      if (nextSegment) {
        children.add(nextSegment);
      }
    }

    return Array.from(children).sort((left, right) => left.localeCompare(right));
  };

  const readFileCalls = [] as string[];

  return {
    readFileCalls,
    fs: {
      async readFile(path: string) {
        readFileCalls.push(path);
        if (!(path in files)) {
          throw new Error(`File not found: ${path}`);
        }

        return files[path]!;
      },
      async readFileBuffer(path: string) {
        readFileCalls.push(path);
        if (!(path in files)) {
          throw new Error(`File not found: ${path}`);
        }

        return new TextEncoder().encode(files[path]!);
      },
      async stat(path: string) {
        if (path in files) {
          return {
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
            mode: 0o644,
            size: files[path]!.length,
            mtime: new Date(0),
          };
        }

        if (
          directories.has(path.replace(/\/+$/, "")) ||
          directories.has(normalizeDirectory(path))
        ) {
          return {
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
            mode: 0o755,
            size: 0,
            mtime: new Date(0),
          };
        }

        throw new Error(`Path not found: ${path}`);
      },
      async readdir(path: string) {
        return listChildren(path);
      },
      resolvePath(base: string, path: string) {
        const normalizedBase = base.replace(/\/+$/, "");
        const normalizedChild = path.replace(/^\/+/, "");
        return normalizedBase ? `${normalizedBase}/${normalizedChild}` : `/${normalizedChild}`;
      },
      getAllPaths() {
        return [...directories, ...Object.keys(files)].sort((left, right) =>
          left.localeCompare(right),
        );
      },
    } as never,
  };
}

function normalizeDirectory(path: string) {
  return path === "/" ? path : `${path.replace(/\/+$/, "")}/`;
}
