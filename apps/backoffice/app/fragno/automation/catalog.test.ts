import { describe, expect, test } from "vitest";

import {
  STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH,
  STARTER_AUTOMATION_SCRIPT_PATHS,
  createMasterFileSystem,
  type FilesContext,
  type IFileSystem,
} from "@/files";

import {
  AUTOMATION_BINDINGS_MANIFEST_PATH,
  AUTOMATION_SCRIPT_AGENT_ENV_KEY,
  AUTOMATION_WORKSPACE_ROOT,
  getAutomationBindingsForEvent,
  listAutomationWorkspaceScripts,
  loadAutomationCatalog,
  readAutomationWorkspaceScript,
} from "./catalog";
import { AUTOMATION_SOURCE_EVENT_TYPES, AUTOMATION_SOURCES } from "./contracts";

const createAutomationFileSystem = async (customFiles: Record<string, string> = {}) => {
  if (Object.keys(customFiles).length === 0) {
    return createMasterFileSystem({
      orgId: "org_123",
      backend: "backoffice",
      uploadConfig: null,
    } satisfies FilesContext);
  }

  return createAutomationTestFileSystem(customFiles);
};

const createAutomationTestFileSystem = (files: Record<string, string>): IFileSystem => {
  const absoluteFiles = new Map(
    Object.entries(files).map(([path, content]) => [
      `/starter/${path.replace(/^\/+/, "")}`,
      content,
    ]),
  );
  const directories = new Set<string>(["/", "/starter", "/starter/automations"]);

  for (const path of absoluteFiles.keys()) {
    const segments = path.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(`/${segments.slice(0, index).join("/")}`);
    }
  }

  return {
    resolvePath(base, path) {
      if (path.startsWith("/")) {
        return path;
      }

      return `${base.replace(/\/+$/, "")}/${path}`.replace(/\/+/g, "/");
    },
    async readFile(path) {
      const content = absoluteFiles.get(path);
      if (content === undefined) {
        throw new Error("File not found.");
      }

      return content;
    },
    async readdirWithFileTypes(path) {
      const normalized = path.replace(/\/+$/, "") || "/";
      if (!directories.has(normalized)) {
        throw new Error("Path not found.");
      }

      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      const names = new Set<string>();

      for (const candidate of [...directories, ...absoluteFiles.keys()]) {
        if (candidate === normalized || !candidate.startsWith(prefix)) {
          continue;
        }

        const name = candidate.slice(prefix.length).split("/", 1)[0];
        if (name) {
          names.add(name);
        }
      }

      return Array.from(names).map((name) => {
        const childPath = normalized === "/" ? `/${name}` : `${normalized}/${name}`;
        return {
          name,
          isFile: absoluteFiles.has(childPath),
          isDirectory: directories.has(childPath),
          isSymbolicLink: false,
        };
      });
    },
  } as IFileSystem;
};

const withFileSystemOverrides = <T extends object>(fileSystem: T, overrides: Partial<T>): T =>
  Object.assign(Object.create(fileSystem), overrides);

describe("automation catalog", () => {
  test("loads the starter automation manifest and scripts from /starter", async () => {
    const fileSystem = await createAutomationFileSystem();
    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.manifestPath).toBe(AUTOMATION_BINDINGS_MANIFEST_PATH);
    expect(catalog.bindings.length).toBeGreaterThan(0);
    expect(catalog.scripts.length).toBeGreaterThan(0);
    expect(catalog.bindings.every((binding) => binding.scriptBody.trim().length > 0)).toBe(true);

    const telegramBindings = getAutomationBindingsForEvent(catalog, {
      source: AUTOMATION_SOURCES.telegram,
      eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
    });
    expect(telegramBindings.length).toBeGreaterThan(0);
    expect(telegramBindings.every((binding) => binding.scriptEngine === "codemode")).toBe(true);
  });

  test("lists workspace scripts even when they are not referenced by bindings.json", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/scripts/unbound-codemode.cm.js": "async () => true",
      "automations/scripts/unbound-workspace-script.sh": 'echo "hello from workspace"',
    });

    const scripts = await listAutomationWorkspaceScripts(fileSystem);

    expect(scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "scripts/unbound-codemode.cm.js",
          absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/scripts/unbound-codemode.cm.js`,
          engine: "codemode",
        }),
        expect.objectContaining({
          path: "scripts/unbound-workspace-script.sh",
          absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/scripts/unbound-workspace-script.sh`,
          engine: "bash",
        }),
      ]),
    );
  });

  test("treats a missing workspace scripts directory as empty", async () => {
    const fileSystem = withFileSystemOverrides(await createAutomationFileSystem(), {
      async readdirWithFileTypes() {
        throw new Error("Path not found.");
      },
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).resolves.toEqual([]);
  });

  test("rethrows non-missing workspace directory errors from readdirWithFileTypes", async () => {
    const fileSystem = withFileSystemOverrides(await createAutomationFileSystem(), {
      async readdirWithFileTypes() {
        throw Object.assign(new Error("Permission denied."), { code: "EACCES" });
      },
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).rejects.toThrow("Permission denied.");
  });

  test("rethrows non-missing workspace directory errors from readdir fallback", async () => {
    const fileSystem = withFileSystemOverrides(await createAutomationFileSystem(), {
      readdirWithFileTypes: undefined,
      async readdir() {
        throw Object.assign(new Error("I/O failure."), { code: "EIO" });
      },
    });

    await expect(listAutomationWorkspaceScripts(fileSystem)).rejects.toThrow("I/O failure.");
  });

  test("reads an individual workspace script only when requested", async () => {
    const fileSystem = await createAutomationFileSystem({
      "automations/scripts/lazy-read.sh": 'echo "lazy"',
    });

    const script = await readAutomationWorkspaceScript(fileSystem, "scripts/lazy-read.sh");

    expect(script).toMatchObject({
      path: "scripts/lazy-read.sh",
      absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/scripts/lazy-read.sh`,
      body: 'echo "lazy"',
    });
  });

  test("rejects malformed manifests with a clear error", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: "{not json}",
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      `Automation manifest '${AUTOMATION_BINDINGS_MANIFEST_PATH}' is not valid JSON`,
    );
  });

  test("rejects manifest bindings without an explicit script engine", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify({
        version: 1,
        bindings: [
          {
            id: "missing-engine",
            source: AUTOMATION_SOURCES.telegram,
            eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
            enabled: true,
            script: {
              key: "missing-engine",
              name: "Missing engine",
              path: "scripts/missing-engine.sh",
              version: 1,
              agent: null,
              env: {},
            },
          },
        ],
      }),
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow("script.engine");
  });

  test("rejects codemode manifest scripts without the .cm.js suffix", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify({
        version: 1,
        bindings: [
          {
            id: "bad-codemode-path",
            source: AUTOMATION_SOURCES.telegram,
            eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
            enabled: true,
            script: {
              key: "bad-codemode-path",
              name: "Bad codemode path",
              engine: "codemode",
              path: "scripts/bad-codemode-path.js",
              version: 1,
              agent: null,
              env: {},
            },
          },
        ],
      }),
      "automations/scripts/bad-codemode-path.js": "async () => true",
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      "codemode scripts must end in .cm.js",
    );
  });

  test("rejects bash manifest scripts with the .cm.js suffix", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify({
        version: 1,
        bindings: [
          {
            id: "bad-bash-path",
            source: AUTOMATION_SOURCES.telegram,
            eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
            enabled: true,
            script: {
              key: "bad-bash-path",
              name: "Bad bash path",
              engine: "bash",
              path: "scripts/bad-bash-path.cm.js",
              version: 1,
              agent: null,
              env: {},
            },
          },
        ],
      }),
      "automations/scripts/bad-bash-path.cm.js": "async () => true",
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      ".cm.js scripts must set engine to codemode",
    );
  });

  test("collects missing-script bindings with script load errors", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "missing-script",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              script: {
                key: "missing-script",
                name: "Missing script",
                engine: "bash",
                path: `${AUTOMATION_WORKSPACE_ROOT}/scripts/missing.sh`,
                version: 1,
                agent: null,
                env: {},
              },
            },
          ],
        },
        null,
        2,
      ),
    });

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.bindings).toHaveLength(1);
    expect(catalog.bindings[0]).toMatchObject({
      id: "missing-script",
      scriptPath: "scripts/missing.sh",
      absoluteScriptPath: `${AUTOMATION_WORKSPACE_ROOT}/scripts/missing.sh`,
      scriptLoadError: expect.stringContaining("Automation script for binding 'missing-script'"),
    });
    expect(catalog.scripts).toHaveLength(1);
    expect(catalog.scripts[0]).toMatchObject({
      id: "script:missing-script@1:scripts/missing.sh",
      scriptLoadError: expect.stringContaining("Automation script for binding 'missing-script'"),
      body: "",
    });
  });

  test("rejects script path traversal and non-scripts paths", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "bad-path",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              script: {
                key: "bad-path",
                name: "Bad path",
                engine: "bash",
                path: "../escape.sh",
                version: 1,
                agent: null,
                env: {},
              },
            },
          ],
        },
        null,
        2,
      ),
      [STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinkingStart]: "echo should-not-load",
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      "Automation binding 'bad-path' has invalid script path '../escape.sh'",
    );
  });

  test("derives a deduplicated scripts view even when bindings override env and agent", async () => {
    const sharedScriptPath = "automations/scripts/shared.sh";
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "binding-a",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              script: {
                key: "shared-script",
                name: "Shared script",
                engine: "bash",
                path: "scripts/shared.sh",
                version: 2,
                agent: "default::openai::gpt-5",
                env: { MODE: "one" },
              },
            },
            {
              id: "binding-b",
              source: AUTOMATION_SOURCES.otp,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted,
              enabled: false,
              script: {
                key: "shared-script",
                name: "Shared script",
                engine: "bash",
                path: "scripts/shared.sh",
                version: 2,
                agent: "default::openai::gpt-5-mini",
                env: { MODE: "two" },
              },
            },
          ],
        },
        null,
        2,
      ),
      [sharedScriptPath]: 'echo "shared"',
    });

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.scripts).toHaveLength(1);
    expect(catalog.scripts[0]).toMatchObject({
      key: "shared-script",
      version: 2,
      bindingIds: ["binding-a", "binding-b"],
      bindingCount: 2,
      enabledBindingCount: 1,
      enabled: true,
    });
    expect(catalog.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "binding-a",
          scriptEnv: {
            MODE: "one",
            [AUTOMATION_SCRIPT_AGENT_ENV_KEY]: "default::openai::gpt-5",
          },
        }),
        expect.objectContaining({
          id: "binding-b",
          scriptEnv: {
            MODE: "two",
            [AUTOMATION_SCRIPT_AGENT_ENV_KEY]: "default::openai::gpt-5-mini",
          },
        }),
      ]),
    );
  });

  test("rejects conflicting legacy and env-based script agent values", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "conflicting-agent",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              script: {
                key: "conflicting-agent",
                name: "Conflicting agent",
                engine: "bash",
                path: "scripts/conflicting-agent.sh",
                version: 1,
                agent: "default::openai::gpt-5",
                env: {
                  [AUTOMATION_SCRIPT_AGENT_ENV_KEY]: "default::openai::gpt-5-mini",
                },
              },
            },
          ],
        },
        null,
        2,
      ),
      "automations/scripts/conflicting-agent.sh": 'echo "agent"',
    });

    await expect(loadAutomationCatalog(fileSystem)).rejects.toThrow(
      `Automation binding 'conflicting-agent' defines both script.agent and script.env.${AUTOMATION_SCRIPT_AGENT_ENV_KEY} with different values.`,
    );
  });

  test("loads custom static starter automation files in tests", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: JSON.stringify(
        {
          version: 1,
          bindings: [
            {
              id: "custom-only-binding",
              source: AUTOMATION_SOURCES.telegram,
              eventType: AUTOMATION_SOURCE_EVENT_TYPES.telegram.messageReceived,
              enabled: true,
              triggerOrder: 5,
              script: {
                key: "custom-script",
                name: "Custom script",
                engine: "bash",
                path: "scripts/custom.sh",
                version: 3,
                agent: null,
                env: { MODE: "custom" },
              },
            },
          ],
        },
        null,
        2,
      ),
      "automations/scripts/custom.sh": 'echo "custom"',
    });

    const catalog = await loadAutomationCatalog(fileSystem);

    expect(catalog.bindings).toHaveLength(1);
    expect(catalog.bindings[0]).toMatchObject({
      id: "custom-only-binding",
      scriptKey: "custom-script",
      scriptPath: "scripts/custom.sh",
      scriptBody: 'echo "custom"',
      scriptEnv: { MODE: "custom" },
      triggerOrder: 5,
    });
    expect(catalog.scripts[0]?.absolutePath).toBe(`${AUTOMATION_WORKSPACE_ROOT}/scripts/custom.sh`);
  });
});
