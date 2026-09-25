import { beforeAll, expect, test, vi } from "vitest";

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { DynamicWorkerExecutor } from "@/fragno/codemode/codemode-executor";

import { compileNodeWorker } from "../dynamic-workers/compile-node-worker";
import { createWorkerBundle } from "../dynamic-workers/worker-bundle";
import { DENO_CODEMODE_PROTOCOL_LIMITS } from "./deno-codemode-runner-source";
import { createDenoWorkerLoader, resolveDenoCodemodeExecutable } from "./deno-worker-loader";

let denoExecutable: string;

function denoProtocolScenarioTest(name: string, assertion: () => Promise<void> | void): void {
  test(name, async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name,
        options: { drain: false },
        steps: ({ then }) => [
          // Crafted child processes exercise transport failures that normal codemode cannot emit.
          then.assert(name, assertion),
        ],
      }),
    );
  });
}

beforeAll(async () => {
  denoExecutable = await resolveDenoCodemodeExecutable(process.env.DENO_EXECUTABLE);
});

const protocolTestBundle = createWorkerBundle({
  mainModule: "protocol-test.js",
  modules: {
    "protocol-test.js": `
      export default class ProtocolTestEntrypoint {
        async run(...args) { return { args }; }
      }
    `,
  },
  runtime: { compatibilityDate: "2026-09-24" },
});

async function runDenoProtocolTest(
  executable: string,
  args: unknown[] = [],
): Promise<Record<string, unknown>> {
  const executor = new DynamicWorkerExecutor({
    loader: createDenoWorkerLoader(executable),
  });
  return await executor.runEntrypoint<
    { run(...args: unknown[]): Promise<Record<string, unknown>> },
    Record<string, unknown>
  >({
    bundle: protocolTestBundle,
    run: (entrypoint) => entrypoint.run(...args) as never,
  });
}

async function runFakeDenoProtocol(
  source: string,
  args: unknown[] = [],
): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-fake-deno-"));
  const executable = path.join(directory, "deno");
  try {
    await writeFile(executable, `#!${process.execPath}\n${source}`);
    await chmod(executable, 0o700);
    return await runDenoProtocolTest(executable, args);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeDenoProtocolSource(onStartSource: string, onMessageSource: string): string {
  return `
    let input = "";
    let start = null;
    function send(message, outputToken = start.token) {
      process.stdout.write(JSON.stringify({ ...message, token: outputToken }) + "\\n");
    }
    function accept(message) {
      if (message.type === "start") {
        start = message;
        ${onStartSource}
        return;
      }
      ${onMessageSource}
    }
    process.stdin.on("data", (chunk) => {
      input += chunk;
      while (true) {
        const newline = input.indexOf("\\n");
        if (newline < 0) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        accept(JSON.parse(line));
      }
    });
  `;
}

denoProtocolScenarioTest(
  "Deno Worker Loader returns plain codemode results and captured logs",
  async () => {
    const executor = new DynamicWorkerExecutor({
      loader: createDenoWorkerLoader(denoExecutable),
    });
    const compiled = await compileNodeWorker({
      files: {
        "executor.js": executor.createExecutorModule(
          `async () => {
          console.log("Hello from Deno codemode");
          return { logged: true, nested: { value: 1 } };
        }`,
          [],
        ),
      },
      entryPoint: "executor.js",
      runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["nodejs_compat"] },
    });

    const result = await executor.execute(compiled.bundle, []);

    expect(result).toEqual({
      result: { logged: true, nested: { value: 1 } },
      logs: ["Hello from Deno codemode"],
      workflowDefinition: undefined,
    });
    expect(Object.getPrototypeOf(result.result)).toBe(Object.prototype);
  },
);

denoProtocolScenarioTest("Deno codemode denies host capabilities", async () => {
  const executor = new DynamicWorkerExecutor({
    loader: createDenoWorkerLoader(denoExecutable),
  });
  const compiled = await compileNodeWorker({
    files: {
      "executor.js": executor.createExecutorModule(
        `async () => {
          const denied = {};
          try { await Deno.readTextFile("/etc/hosts"); } catch (error) { denied.read = error.name; }
          try { await fetch("https://example.com"); } catch (error) { denied.net = error.name; }
          try { Deno.env.get("HOME"); } catch (error) { denied.env = error.name; }
          try { await new Deno.Command("/bin/echo", { args: ["unsafe"] }).output(); } catch (error) { denied.run = error.name; }
          return denied;
        }`,
        [],
      ),
    },
    entryPoint: "executor.js",
    runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["nodejs_compat"] },
  });

  const result = await executor.execute(compiled.bundle, []);

  expect(result.result).toEqual({
    read: "NotCapable",
    net: "NotCapable",
    env: "NotCapable",
    run: "NotCapable",
  });
});

denoProtocolScenarioTest("Deno Worker Loader rejects inherited host methods", async () => {
  const executor = new DynamicWorkerExecutor({
    loader: createDenoWorkerLoader(denoExecutable),
  });
  const bundle = createWorkerBundle({
    mainModule: "host-methods.js",
    modules: {
      "host-methods.js": `
        export default class HostMethodsEntrypoint {
          async run(target) {
            const callback = await target.callback();
            const errors = [];
            for (const method of ["constructor", "__proto__", "__lookupGetter__"]) {
              try {
                await callback[method]("return globalThis.process");
              } catch (error) {
                errors.push(error.message);
              }
            }
            return errors;
          }
        }
      `,
    },
    runtime: { compatibilityDate: "2026-09-24" },
  });
  const target = {
    callback() {
      return () => "safe";
    },
  };

  await expect(
    executor.runEntrypoint<{ run(target: unknown): Promise<string[]> }, string[]>({
      bundle,
      run: (entrypoint) => entrypoint.run(target) as never,
    }),
  ).resolves.toEqual([
    "DENO_CODEMODE_RPC_HOST_METHOD_NOT_FOUND:constructor",
    "DENO_CODEMODE_RPC_HOST_METHOD_NOT_FOUND:__proto__",
    "DENO_CODEMODE_RPC_HOST_METHOD_NOT_FOUND:__lookupGetter__",
  ]);
});

denoProtocolScenarioTest(
  "Deno Worker Loader fails immediately on malformed protocol JSON",
  async () => {
    await expect(
      runFakeDenoProtocol(`
      process.stdin.once("data", () => {
        process.stdout.write("{malformed\\n");
        setInterval(() => {}, 1000);
      });
    `),
    ).rejects.toThrow("DENO_CODEMODE_RPC_MALFORMED_JSON");
  },
);

denoProtocolScenarioTest(
  "Deno Worker Loader rejects a malformed bigint result without crashing Node",
  async () => {
    await expect(
      runFakeDenoProtocol(
        fakeDenoProtocolSource(
          `
          send({
            version: 1,
            type: "complete",
            ok: true,
            value: { kind: "bigint", value: "not-a-bigint" },
          });
        `,
          "",
        ),
      ),
    ).rejects.toThrow("DENO_CODEMODE_RPC_INVALID_WIRE_VALUE:bigint");
  },
);

denoProtocolScenarioTest(
  "Deno Worker Loader rejects a malformed guest callback result without crashing Node",
  async () => {
    const target = {
      async invoke(callback: unknown) {
        return await (callback as () => Promise<unknown>)();
      },
    };

    await expect(
      runFakeDenoProtocol(
        fakeDenoProtocolSource(
          `
          send({
            version: 1,
            type: "callHost",
            id: "invoke-callback",
            referenceId: start.args[0].value.invoke.id,
            method: null,
            args: [{ kind: "remote", id: "guest-callback", callable: true }],
          });
        `,
          `
          if (message.type === "callGuest") {
            send({
              version: 1,
              type: "guestResult",
              id: message.id,
              ok: true,
              value: { kind: "bigint", value: "not-a-bigint" },
            });
          }
        `,
        ),
        [target],
      ),
    ).rejects.toThrow("DENO_CODEMODE_RPC_INVALID_WIRE_VALUE:bigint");
  },
);

denoProtocolScenarioTest("Deno Worker Loader ignores wrong-token frames", async () => {
  const completeMessage = `{
    version: 1,
    type: "complete",
    ok: true,
    value: { kind: "object", value: { accepted: { kind: "boolean", value: true } } },
  }`;
  const result = await runFakeDenoProtocol(
    fakeDenoProtocolSource(
      `
        send(${completeMessage}, "wrong-token");
        send(${completeMessage});
      `,
      "",
    ),
  );

  expect(result).toEqual({ accepted: true });
});

denoProtocolScenarioTest(
  "Deno Worker Loader rejects an oversized frame split across stdout chunks",
  async () => {
    await expect(
      runFakeDenoProtocol(`
      process.stdout.on("error", () => process.exit(0));
      process.stdin.once("data", () => {
        let remaining = ${DENO_CODEMODE_PROTOCOL_LIMITS.maxFrameBytes + 1};
        const chunk = "x".repeat(4096);
        function writeChunk() {
          if (remaining <= 0) return;
          const output = chunk.slice(0, Math.min(chunk.length, remaining));
          remaining -= output.length;
          if (process.stdout.write(output)) setImmediate(writeChunk);
          else process.stdout.once("drain", writeChunk);
        }
        writeChunk();
      });
    `),
    ).rejects.toThrow("DENO_CODEMODE_RPC_FRAME_TOO_LARGE");
  },
);

denoProtocolScenarioTest("Deno Worker Loader rejects an oversized outbound frame", async () => {
  await expect(
    runFakeDenoProtocol("setInterval(() => {}, 1000);", [
      "x".repeat(DENO_CODEMODE_PROTOCOL_LIMITS.maxFrameBytes),
    ]),
  ).rejects.toThrow("DENO_CODEMODE_RPC_FRAME_TOO_LARGE");
});

denoProtocolScenarioTest("Deno guest runtime limits pending host calls", async () => {
  const executor = new DynamicWorkerExecutor({
    loader: createDenoWorkerLoader(denoExecutable),
  });
  const bundle = createWorkerBundle({
    mainModule: "host-calls.js",
    modules: {
      "host-calls.js": `
        export default class HostCallsEntrypoint {
          async run(target) {
            return await Promise.all(
              Array.from(
                { length: ${DENO_CODEMODE_PROTOCOL_LIMITS.maxActiveHostCalls + 1} },
                async () => await target.wait(),
              ),
            );
          }
        }
      `,
    },
    runtime: { compatibilityDate: "2026-09-24" },
  });
  const target = {
    async wait() {
      return await new Promise(() => {});
    },
  };

  await expect(
    executor.runEntrypoint<
      { run(target: unknown): Promise<Record<string, unknown>> },
      Record<string, unknown>
    >({
      bundle,
      run: (entrypoint) => entrypoint.run(target) as never,
    }),
  ).rejects.toThrow("DENO_CODEMODE_RPC_HOST_CALL_LIMIT_EXCEEDED");
});

denoProtocolScenarioTest("Deno Worker Loader limits concurrent guest-to-host calls", async () => {
  const target = {
    async wait() {
      return await new Promise(() => {});
    },
  };

  await expect(
    runFakeDenoProtocol(
      fakeDenoProtocolSource(
        `
          const referenceId = start.args[0].value.wait.id;
          for (
            let index = 0;
            index < ${DENO_CODEMODE_PROTOCOL_LIMITS.maxActiveHostCalls + 1};
            index += 1
          ) {
            send({
              version: 1,
              type: "callHost",
              id: "host-call-" + index,
              referenceId,
              method: null,
              args: [],
            });
          }
        `,
        "",
      ),
      [target],
    ),
  ).rejects.toThrow("DENO_CODEMODE_RPC_HOST_CALL_LIMIT_EXCEEDED");
});

denoProtocolScenarioTest("Deno Worker Loader limits concurrent host-to-guest calls", async () => {
  const target = {
    async fanOut(callback: unknown) {
      const guestCallback = callback as () => Promise<unknown>;
      return await Promise.all(
        Array.from(
          { length: DENO_CODEMODE_PROTOCOL_LIMITS.maxPendingGuestCalls + 1 },
          async () => await guestCallback(),
        ),
      );
    },
  };

  await expect(
    runFakeDenoProtocol(
      fakeDenoProtocolSource(
        `
          send({
            version: 1,
            type: "callHost",
            id: "fan-out",
            referenceId: start.args[0].value.fanOut.id,
            method: null,
            args: [{ kind: "remote", id: "guest-callback", callable: true }],
          });
        `,
        "",
      ),
      [target],
    ),
  ).rejects.toThrow("DENO_CODEMODE_RPC_GUEST_CALL_LIMIT_EXCEEDED");
});

denoProtocolScenarioTest("Deno Worker Loader caps host remote references", async () => {
  const references = Array.from(
    { length: DENO_CODEMODE_PROTOCOL_LIMITS.maxRemoteReferences + 1 },
    () => () => {},
  );

  await expect(runFakeDenoProtocol("setInterval(() => {}, 1000);", [references])).rejects.toThrow(
    "DENO_CODEMODE_RPC_REFERENCE_LIMIT_EXCEEDED",
  );
});

denoProtocolScenarioTest(
  "Deno Worker Loader reuses a host reference ID for the same value",
  async () => {
    const sharedReference = () => {};
    const result = await runFakeDenoProtocol(
      fakeDenoProtocolSource(
        `
        const references = start.args[0].value;
        send({
          version: 1,
          type: "complete",
          ok: true,
          value: {
            kind: "object",
            value: {
              same: { kind: "boolean", value: references[0].id === references[1].id },
            },
          },
        });
      `,
        "",
      ),
      [[sharedReference, sharedReference]],
    );

    expect(result).toEqual({ same: true });
  },
);

denoProtocolScenarioTest("Deno Worker Loader caps guest remote references", async () => {
  const executor = new DynamicWorkerExecutor({
    loader: createDenoWorkerLoader(denoExecutable),
  });
  const bundle = createWorkerBundle({
    mainModule: "references.js",
    modules: {
      "references.js": `
        export default class ReferencesEntrypoint {
          async run() {
            return {
              references: Array.from(
                { length: ${DENO_CODEMODE_PROTOCOL_LIMITS.maxRemoteReferences + 1} },
                () => () => {},
              ),
            };
          }
        }
      `,
    },
    runtime: { compatibilityDate: "2026-09-24" },
  });

  await expect(
    executor.runEntrypoint<{ run(): Promise<Record<string, unknown>> }, Record<string, unknown>>({
      bundle,
      run: (entrypoint) => entrypoint.run() as never,
    }),
  ).rejects.toThrow("DENO_CODEMODE_RPC_REFERENCE_LIMIT_EXCEEDED");
});

denoProtocolScenarioTest(
  "Deno Worker Loader preserves frames while stdin is backpressured",
  async () => {
    const target = {
      async largeResult() {
        return "x".repeat(256 * 1024);
      },
    };
    const result = await runFakeDenoProtocol(
      fakeDenoProtocolSource(
        `
        process.stdin.pause();
        const referenceId = start.args[0].value.largeResult.id;
        for (let index = 0; index < 32; index += 1) {
          send({
            version: 1,
            type: "callHost",
            id: "large-result-" + index,
            referenceId,
            method: null,
            args: [],
          });
        }
        setTimeout(() => process.stdin.resume(), 200);
      `,
        `
        if (message.type === "hostResult") {
          if (!message.ok || message.value.value.length !== 256 * 1024) process.exit(2);
          globalThis.resultCount = (globalThis.resultCount || 0) + 1;
          if (globalThis.resultCount === 32) {
            send({
              version: 1,
              type: "complete",
              ok: true,
              value: { kind: "object", value: { complete: { kind: "boolean", value: true } } },
            });
          }
        }
      `,
      ),
      [target],
    );

    expect(result).toEqual({ complete: true });
  },
);

denoProtocolScenarioTest(
  "Deno Worker Loader rejects pending guest calls when the process exits",
  async () => {
    let observeCallbackError: (error: Error) => void = () => {};
    const callbackError = new Promise<Error>((resolve) => {
      observeCallbackError = resolve;
    });
    const target = {
      async invoke(callback: unknown) {
        try {
          return await (callback as () => Promise<unknown>)();
        } catch (error) {
          observeCallbackError(error as Error);
          throw error;
        }
      },
    };

    await expect(
      runFakeDenoProtocol(
        fakeDenoProtocolSource(
          `
          send({
            version: 1,
            type: "callHost",
            id: "invoke-callback",
            referenceId: start.args[0].value.invoke.id,
            method: null,
            args: [{ kind: "remote", id: "guest-callback", callable: true }],
          });
        `,
          `
          if (message.type === "callGuest") process.exit(0);
        `,
        ),
        [target],
      ),
    ).rejects.toThrow("Deno codemode process exited before completing");
    await expect(callbackError).resolves.toMatchObject({
      message: "DENO_CODEMODE_RPC_PROCESS_ENDED_BEFORE_GUEST_CALL_COMPLETED",
    });
  },
);

denoProtocolScenarioTest("Deno Worker Loader limits deeply nested wire values", async () => {
  let nested: unknown = null;
  for (let depth = 0; depth < DENO_CODEMODE_PROTOCOL_LIMITS.maxWireDepth + 2; depth += 1) {
    nested = [nested];
  }

  await expect(runFakeDenoProtocol("setInterval(() => {}, 1000);", [nested])).rejects.toThrow(
    "DENO_CODEMODE_RPC_WIRE_DEPTH_LIMIT_EXCEEDED",
  );
});

denoProtocolScenarioTest("Deno executable resolution uses the parent process PATH", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-path-deno-"));
  const executableName = process.platform === "win32" ? "deno.exe" : "deno";
  const executable = path.join(directory, executableName);
  const originalPath = process.env.PATH;
  try {
    await writeFile(executable, `#!${process.execPath}\nconsole.log("deno 2.0.0");`);
    await chmod(executable, 0o700);
    process.env.PATH = directory;

    await expect(resolveDenoCodemodeExecutable(undefined)).resolves.toBe(executable);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

denoProtocolScenarioTest(
  "Deno executable resolution preserves a Windows PATHEXT extension",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-path-deno-extension-"));
    const executable = path.join(directory, "deno.exe");
    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await writeFile(executable, `#!${process.execPath}\nconsole.log("deno 2.0.0");`);
      await chmod(executable, 0o700);
      process.env.PATH = directory;
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

      await expect(resolveDenoCodemodeExecutable(undefined)).resolves.toBe(executable);
    } finally {
      platform.mockRestore();
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = originalPathExt;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

denoProtocolScenarioTest(
  "Deno Worker Loader bridges nested callbacks to Node RPC targets",
  async () => {
    const executor = new DynamicWorkerExecutor({
      loader: createDenoWorkerLoader(denoExecutable),
    });
    const bundle = createWorkerBundle({
      mainModule: "callback.js",
      modules: {
        "callback.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { AsyncLocalStorage } from "node:async_hooks";
        export default class CallbackEntrypoint extends WorkerEntrypoint {
          async run(target) {
            const storage = new AsyncLocalStorage();
            return await target.callWith(async (value) =>
              await storage.run("workflow-scope", async () => ({
                echoed: value,
                scope: storage.getStore(),
              })),
            );
          }
        }
      `,
      },
      runtime: { compatibilityDate: "2026-05-07" },
    });
    type CallbackTarget = {
      callWith(callback: (value: string) => Promise<unknown>): Promise<unknown>;
    };
    const target: CallbackTarget = {
      async callWith(callback) {
        return await callback("from-node");
      },
    };

    const result = await executor.runEntrypoint<
      { run(target: CallbackTarget): Promise<{ echoed: string; scope: string }> },
      { echoed: string; scope: string }
    >({
      bundle,
      rpcTargets: { target },
      run: (entrypoint, targets) => entrypoint.run(targets.target as CallbackTarget) as never,
    });

    expect(result).toEqual({ echoed: "from-node", scope: "workflow-scope" });
  },
);
