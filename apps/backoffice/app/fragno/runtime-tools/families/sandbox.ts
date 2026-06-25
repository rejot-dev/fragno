import { z } from "zod";

import {
  defineCliArgsParser,
  defineEmptyArgsParser,
  parseCliTokens,
  readOutputOptions,
} from "@/fragno/runtime-tools/bash-cli";
import type { StartSandboxOptions } from "@/sandbox/contracts";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { SandboxExecuteCommandArgs, SandboxKillArgs, SandboxRuntime } from "./sandbox-runtime";

export type { SandboxRuntime } from "./sandbox-runtime";

type SandboxToolContext = BackofficeToolContext<{ sandbox?: SandboxRuntime }>;

const startInputSchema = z.object({
  id: z.string().trim().min(1),
  keepAlive: z.boolean().optional(),
  sleepAfter: z.union([z.string(), z.number()]).optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
  startupCommand: z.string().trim().min(1).optional(),
});

const sandboxStatusSchema = z.enum([
  "requested",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);

const execInputSchema = z.object({
  sandboxId: z.string().trim().min(1),
  command: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().optional(),
});
const commandResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), stdout: z.string(), stderr: z.string(), exitCode: z.number() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      "command_failed",
      "timeout",
      "sandbox_terminated",
      "sandbox_unavailable",
      "internal_error",
    ]),
    message: z.string(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().optional(),
    retryable: z.boolean(),
  }),
]);

const getSandboxRuntime = (runtime: SandboxToolContext["runtimes"]["sandbox"]): SandboxRuntime => {
  if (!runtime) {
    throw new Error("Sandbox runtime is not available in this execution context");
  }
  return runtime;
};

const parseStart = defineCliArgsParser<StartSandboxOptions>("sandbox.start", {
  id: { required: true },
  keepAlive: { kind: "boolean" },
  sleepAfter: {},
  startupCommand: {},
  startupTimeoutMs: { kind: "integer" },
});

const parseList = defineEmptyArgsParser("sandbox.list");

const parseKill = defineCliArgsParser<SandboxKillArgs>("sandbox.kill", {
  sandboxId: { required: true },
});

const parseExec = defineCliArgsParser<SandboxExecuteCommandArgs>("sandbox.exec", {
  sandboxId: { required: true },
  command: { required: true },
  timeoutMs: { kind: "integer" },
});

const jsonDefault = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format") ? output : { format: "json" as const };
};

const startSandboxTool = defineBackofficeRuntimeTool({
  id: "sandbox.start",
  namespace: "sandbox",
  name: "startSandbox",
  description: "Start a Cloudflare sandbox for the current organisation.",
  requiredPermissions: ["modify"],
  inputSchema: startInputSchema,
  outputSchema: z.object({
    id: z.string().trim().min(1),
    status: sandboxStatusSchema,
  }),
  execute: async (input, context: SandboxToolContext) =>
    await getSandboxRuntime(context.runtimes.sandbox).startSandbox(input),
  adapters: {
    bash: {
      command: "sandbox.start",
      help: {
        summary: "sandbox.start starts a Cloudflare sandbox.",
        options: [
          {
            name: "id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Sandbox id.",
          },
          {
            name: "keep-alive",
            valueRequired: true,
            valueName: "boolean",
            description: "Whether to keep the sandbox alive.",
          },
          {
            name: "sleep-after",
            valueRequired: true,
            valueName: "duration",
            description: "Idle timeout, for example 15m.",
          },
          {
            name: "startup-command",
            valueRequired: true,
            valueName: "command",
            description: "Startup health command.",
          },
          {
            name: "startup-timeout-ms",
            valueRequired: true,
            valueName: "ms",
            description: "Startup timeout in milliseconds.",
          },
        ],
        examples: ['sandbox.start --id dev --sleep-after 15m --startup-command "true"'],
      },
      parse: parseStart,
      outputOptions: jsonDefault,
      format: (result) => ({ data: result }),
    },
  },
});

const listSandboxesTool = defineBackofficeRuntimeTool({
  id: "sandbox.list",
  namespace: "sandbox",
  name: "listSandboxes",
  description: "List Cloudflare sandboxes for the current organisation.",
  requiredPermissions: ["read"],
  inputSchema: z.object({}),
  outputSchema: z.array(z.object({ id: z.string().trim().min(1), status: sandboxStatusSchema })),
  execute: async (_input, context: SandboxToolContext) =>
    await getSandboxRuntime(context.runtimes.sandbox).listSandboxes(),
  adapters: {
    bash: {
      command: "sandbox.list",
      help: {
        summary: "sandbox.list lists Backoffice-managed Cloudflare sandbox instances.",
        options: [],
        examples: ["sandbox.list --format json"],
      },
      parse: parseList,
      outputOptions: jsonDefault,
      format: (result) => ({ data: result }),
    },
  },
});

const killSandboxTool = defineBackofficeRuntimeTool({
  id: "sandbox.kill",
  namespace: "sandbox",
  name: "killSandbox",
  description: "Kill a Cloudflare sandbox for the current organisation.",
  requiredPermissions: ["modify"],
  inputSchema: z.object({ sandboxId: z.string().trim().min(1) }),
  outputSchema: z.object({ sandboxId: z.string().trim().min(1), killed: z.literal(true) }),
  execute: async (input, context: SandboxToolContext) =>
    await getSandboxRuntime(context.runtimes.sandbox).killSandbox(input),
  adapters: {
    bash: {
      command: "sandbox.kill",
      help: {
        summary: "sandbox.kill destroys a Cloudflare sandbox.",
        options: [
          {
            name: "sandbox-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Sandbox id.",
          },
        ],
        examples: ["sandbox.kill --sandbox-id dev"],
      },
      parse: parseKill,
      outputOptions: jsonDefault,
      format: (result) => ({ data: result }),
    },
  },
});

const executeCommandTool = defineBackofficeRuntimeTool({
  id: "sandbox.exec",
  namespace: "sandbox",
  name: "executeCommand",
  description: "Execute a command in a Cloudflare sandbox.",
  requiredPermissions: ["modify"],
  inputSchema: execInputSchema,
  outputSchema: commandResultSchema,
  execute: async (input, context: SandboxToolContext) =>
    await getSandboxRuntime(context.runtimes.sandbox).executeCommand(input),
  adapters: {
    bash: {
      command: "sandbox.exec",
      help: {
        summary: "sandbox.exec executes a command inside a sandbox.",
        options: [
          {
            name: "sandbox-id",
            required: true,
            valueRequired: true,
            valueName: "id",
            description: "Sandbox id.",
          },
          {
            name: "command",
            required: true,
            valueRequired: true,
            valueName: "command",
            description: "Command to execute.",
          },
          {
            name: "timeout-ms",
            valueRequired: true,
            valueName: "ms",
            description: "Execution timeout in milliseconds.",
          },
        ],
        examples: ['sandbox.exec --sandbox-id dev --command "pwd && ls -la" --timeout-ms 30000'],
      },
      parse: parseExec,
      format: (result) =>
        result.ok
          ? {
              data: result,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            }
          : {
              data: result,
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? result.message,
              exitCode: result.exitCode ?? 1,
            },
    },
  },
});

// Override the exec bash adapter with context-aware execution while keeping generated references above.
executeCommandTool.adapters!.bash!.execute = async ({ input, context }) => {
  const parsedInput = execInputSchema.parse(input);
  const result = commandResultSchema.parse(
    await getSandboxRuntime(context.runtimes.sandbox).executeCommand(parsedInput),
  );
  if (result.ok) {
    return {
      data: result,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
  return {
    data: result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.message,
    exitCode: result.exitCode ?? 1,
  };
};

export const sandboxRuntimeTools = [
  startSandboxTool,
  listSandboxesTool,
  killSandboxTool,
  executeCommandTool,
] as const;

export const sandboxToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "sandbox",
  permissions: {
    read: "List sandboxes.",
    modify: "Start, stop, and execute commands in sandboxes.",
  },
  tools: sandboxRuntimeTools,
  isAvailable: (context: SandboxToolContext) => !!context.runtimes.sandbox,
});
