import { beforeEach, describe, expect, test, vi } from "vitest";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";

const { readBackofficeAutomationSourceMock } = vi.hoisted(() => ({
  readBackofficeAutomationSourceMock: vi.fn(),
}));

vi.mock("@/fragno/automation/read-backoffice-automation-source", () => ({
  readBackofficeAutomationSource: readBackofficeAutomationSourceMock,
}));

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
  readBackofficeAutomationSourceMock.mockReset();
});

describe("automation backoffice workspace data", () => {
  test("reads visible static script source from org scope", async () => {
    const fileSystem = createStubAutomationFileSystem({
      "/static/automations/project-files-configure.workflow.js": "configure",
    });
    readBackofficeAutomationSourceMock.mockImplementation(({ path }) =>
      fileSystem.fs.readFile(path),
    );

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
    readBackofficeAutomationSourceMock.mockImplementation(({ path }) =>
      fileSystem.fs.readFile(path),
    );

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
    readBackofficeAutomationSourceMock.mockImplementation(({ path }) =>
      fileSystem.fs.readFile(path),
    );

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
    readBackofficeAutomationSourceMock.mockImplementation(({ path }) =>
      fileSystem.fs.readFile(path),
    );

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
  };

  return { fs, readFileCalls };
}
