import { assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { seedWorkspaceStarterFiles } from "@/files/seed-workspace-starter-files";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryMcpObject } from "../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { createInteractiveBashHost } from "./automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "./route-backed-runtime-context";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

function createScenarioShell(ctx: BackofficeScenarioContext) {
  const context = createCodemodeRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeSystemExecution({ kind: "org", orgId: "org-1" }),
    billingOrganizationId: null,
  });
  return { ...createInteractiveBashHost({ context }), state: context.stateBackend };
}

describe("shared state shell scenarios", () => {
  test("shell operations and state tools share text, binary files, and directory mutations", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Shell and state share scoped Upload files",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("shell mutations are visible through the same state backend", async (ctx) => {
            const { bash, state } = createScenarioShell(ctx);
            await state.writeFile("/workspace/state.txt", "from state\n");
            const result = await bash.exec(
              [
                "mkdir -p /workspace/shell/nested",
                "cat /workspace/state.txt > /workspace/shell/nested/notes.txt",
                "printf 'from shell\\n' >> /workspace/shell/nested/notes.txt",
                "cp -r /workspace/shell /workspace/copy",
                "cp /static/SYSTEM.md /workspace/reference.md",
                "mv /workspace/copy/nested/notes.txt /workspace/moved.txt",
                "rm -r /workspace/copy",
                "cat /workspace/moved.txt",
              ].join(" && "),
              { cwd: "/" },
            );
            assert.equal(result.exitCode, 0, result.stderr);
            assert.equal(result.stdout, "from state\nfrom shell\n");
            await expect(state.readFile("/workspace/moved.txt")).resolves.toBe(result.stdout);
            await expect(state.exists("/workspace/copy")).resolves.toBe(false);
            await expect(state.readdir("/workspace/shell/nested")).resolves.toEqual(["notes.txt"]);
            assert.equal(
              await state.readFile("/workspace/reference.md"),
              await state.readFile("/static/SYSTEM.md"),
            );

            const bytes = new Uint8Array([0, 255, 128, 65, 10]);
            await state.writeFileBytes("/workspace/input.bin", bytes);
            const binaryCopy = await bash.exec("cat /workspace/input.bin > /workspace/output.bin", {
              cwd: "/",
            });
            expect(binaryCopy.exitCode, binaryCopy.stderr).toBe(0);
            await expect(state.readFileBytes("/workspace/output.bin")).resolves.toEqual(bytes);
          }),
        ],
      }),
    );
  });

  test("touch creates empty shared files without changing existing content or storage timestamps", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Touch is compatible with storage-owned timestamps",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("touch succeeds for new and existing workspace entries", async (ctx) => {
            const { bash, state } = createScenarioShell(ctx);
            const bytes = new Uint8Array([0, 255, 128, 65, 10]);
            await state.writeFileBytes("/workspace/existing.bin", bytes);
            await state.mkdir("/workspace/folder");
            const originalStat = await state.stat("/workspace/existing.bin");
            const result = await bash.exec(
              [
                "touch /workspace/hello.txt",
                "touch /workspace/hello2.txt",
                "touch /workspace/existing.bin /workspace/folder",
                "touch -c /workspace/absent.txt",
                "touch -d '2000-01-01 00:00:00' /workspace/existing.bin",
              ].join(" && "),
              { cwd: "/" },
            );
            assert.equal(result.exitCode, 0, result.stderr);
            assert.equal(result.stderr, "");
            await expect(state.readFileBytes("/workspace/hello.txt")).resolves.toEqual(
              new Uint8Array(),
            );
            await expect(state.readFileBytes("/workspace/hello2.txt")).resolves.toEqual(
              new Uint8Array(),
            );
            await expect(state.readFileBytes("/workspace/existing.bin")).resolves.toEqual(bytes);
            await expect(state.stat("/workspace/existing.bin")).resolves.toEqual(originalStat);
            await expect(state.readdir("/workspace/folder")).resolves.toEqual([]);
            await expect(state.exists("/workspace/absent.txt")).resolves.toBe(false);
            await expect(
              bash.fs.utimes("/workspace/missing.txt", new Date(0), new Date(0)),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }),
        ],
      }),
    );
  });

  test("retired permissions fail explicitly and immutable roots cannot be mutated", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Shell uses state scope rules rather than POSIX ownership",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert(
            "unsupported metadata operations leave shared files unchanged",
            async (ctx) => {
              const { bash, state } = createScenarioShell(ctx);
              await state.writeFile("/workspace/keep.txt", "keep");
              const roots = await bash.exec("ls /", { cwd: "/" });
              expect(roots.exitCode, roots.stderr).toBe(0);
              expect(roots.stdout.trim().split(/\s+/u)).toEqual(["static", "workspace"]);

              for (const command of [
                "chmod 000 /workspace/keep.txt",
                "ln /workspace/keep.txt /workspace/link.txt",
              ]) {
                const result = await bash.exec(command, { cwd: "/" });
                expect(result.exitCode, command).not.toBe(0);
                assert(result.stderr.length > 0);
              }
              await expect(bash.fs.chmod("/workspace/keep.txt", 0)).rejects.toMatchObject({
                code: "ENOTSUP",
              });
              await expect(
                bash.exec("echo changed > /static/SYSTEM.md", { cwd: "/" }),
              ).rejects.toMatchObject({ code: "EROFS" });
              const rootRemoval = await bash.exec("rm -r /workspace", { cwd: "/" });
              expect(rootRemoval.exitCode).not.toBe(0);
              await bash.exec("rm -rf /workspace", { cwd: "/" });
              await expect(
                bash.fs.rm("/workspace", { recursive: true, force: true }),
              ).rejects.toMatchObject({ code: "EPERM" });
              await expect(state.readFile("/workspace/keep.txt")).resolves.toBe("keep");
              await expect(state.exists("/workspace/link.txt")).resolves.toBe(false);
            },
          ),
        ],
      }),
    );
  });

  test("starter seeding skips edits unless explicitly forced and writes no ownership metadata", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "Starter files are ordinary scope-owned state",
        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
        steps: ({ then }) => [
          then.assert("forced seeding restores content without a permission model", async (ctx) => {
            const { state } = createScenarioShell(ctx);
            await state.writeFile("/workspace/AGENTS.md", "edited guidance");
            const input = {
              objects: ctx.runtime.objects,
              scope: { kind: "org" as const, orgId: "org-1" },
            };
            const skipped = await seedWorkspaceStarterFiles(input);
            expect(skipped.skipped).toContain("/workspace/AGENTS.md");
            await expect(state.readFile("/workspace/AGENTS.md")).resolves.toBe("edited guidance");
            const restored = await seedWorkspaceStarterFiles({ ...input, force: true });
            expect(restored.overwritten).toContain("/workspace/AGENTS.md");
            await expect(state.readFile("/workspace/AGENTS.md")).resolves.toContain(
              "Workspace guidance",
            );
            const response = await ctx.runtime.objects.upload
              .forOrg("org-1")
              .http.fetch(
                new Request(
                  "https://upload.internal/api/upload/files/by-key?provider=database&key=AGENTS.md",
                ),
              );
            assert(response.ok);
            const file = (await response.json()) as { metadata: Record<string, unknown> | null };
            expect(file.metadata).toBeNull();
          }),
        ],
      }),
    );
  });
});
