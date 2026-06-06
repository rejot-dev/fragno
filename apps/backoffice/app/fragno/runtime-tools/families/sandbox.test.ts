import { describe, expect, test, vi } from "vitest";

import { Bash, InMemoryFs } from "just-bash";

import { createBackofficeBashCommands, type BackofficeToolContext } from "../runtime-tools";
import { sandboxRuntimeTools, type SandboxRuntime } from "./sandbox";

const createRuntime = (): SandboxRuntime => ({
  listSandboxes: vi.fn(async () => [{ id: "dev", status: "running" as const }]),
  startSandbox: vi.fn(async ({ id }) => ({ id, status: "running" as const })),
  killSandbox: vi.fn(async ({ sandboxId }) => ({ sandboxId, killed: true as const })),
  executeCommand: vi.fn(async ({ command }) => ({
    ok: true as const,
    stdout: `ran:${command}\n`,
    stderr: "",
    exitCode: 0,
  })),
});

const createBash = (runtime: SandboxRuntime) =>
  new Bash({
    fs: new InMemoryFs(),
    customCommands: createBackofficeBashCommands({
      tools: sandboxRuntimeTools,
      context: { runtimes: { sandbox: runtime } },
      commandCallsResult: [],
    }),
  });

describe("sandbox runtime tools", () => {
  test("defines camelCase codemode names and bash commands", () => {
    expect(sandboxRuntimeTools.map((tool) => [tool.name, tool.adapters?.bash?.command])).toEqual([
      ["startSandbox", "sandbox.start"],
      ["listSandboxes", "sandbox.list"],
      ["killSandbox", "sandbox.kill"],
      ["executeCommand", "sandbox.exec"],
    ]);
  });

  test("parses start input", () => {
    const [start] = sandboxRuntimeTools;

    expect(
      start.inputSchema.parse(
        start.adapters!.bash!.parse([
          "--id",
          "Dev",
          "--keep-alive",
          "true",
          "--sleep-after",
          "15m",
          "--startup-command",
          "true",
          "--startup-timeout-ms",
          "1000",
        ]),
      ),
    ).toEqual({
      id: "Dev",
      keepAlive: true,
      sleepAfter: "15m",
      startupCommand: "true",
      startupTimeoutMs: 1000,
    });
  });

  test("invokes semantic runtime for codemode", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ sandbox: SandboxRuntime }> = {
      runtimes: { sandbox: runtime },
    };

    await expect(
      sandboxRuntimeTools[3].execute({ sandboxId: "dev", command: "pwd" }, context),
    ).resolves.toMatchObject({ ok: true, stdout: "ran:pwd\n" });
    expect(runtime.executeCommand).toHaveBeenCalledWith({ sandboxId: "dev", command: "pwd" });
  });

  test("routes bash commands through semantic runtime", async () => {
    const runtime = createRuntime();
    const bash = createBash(runtime);

    await expect(bash.exec("sandbox.list --print 0.id")).resolves.toMatchObject({
      stdout: "dev\n",
      exitCode: 0,
    });
    await expect(
      bash.exec('sandbox.exec --sandbox-id dev --command "echo hi"'),
    ).resolves.toMatchObject({
      stdout: "ran:echo hi\n",
      exitCode: 0,
    });

    expect(runtime.listSandboxes).toHaveBeenCalledTimes(1);
    expect(runtime.executeCommand).toHaveBeenCalledWith({ sandboxId: "dev", command: "echo hi" });
  });

  test("propagates sandbox command failures to bash", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.executeCommand).mockResolvedValueOnce({
      ok: false,
      reason: "command_failed",
      message: "failed",
      stdout: "",
      stderr: "boom",
      exitCode: 7,
      retryable: false,
    });
    const bash = createBash(runtime);

    await expect(
      bash.exec('sandbox.exec --sandbox-id dev --command "false"'),
    ).resolves.toMatchObject({
      stdout: "",
      stderr: "boom",
      exitCode: 7,
    });
  });

  test("validates custom sandbox exec bash input before invoking runtime", async () => {
    const runtime = createRuntime();
    const bash = createBash(runtime);

    await expect(
      bash.exec('sandbox.exec --sandbox-id dev --command "pwd" --timeout-ms -1'),
    ).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: expect.stringContaining("Too small"),
    });
    expect(runtime.executeCommand).not.toHaveBeenCalled();
  });
});
