import { z } from "zod";

import {
  assertNoPositionals,
  parseCliTokens,
  readIntegerOption,
  readOutputOptions,
  readStringOption,
} from "@/fragno/runtime-tools/bash-cli";
import type { StartSandboxOptions } from "@/sandbox/contracts";

import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeRuntimeTool,
  type BackofficeToolContext,
} from "../runtime-tools";
import type { SandboxExecuteCommandArgs, SandboxKillArgs, SandboxRuntime } from "./sandbox-runtime";

export type { SandboxRuntime } from "./sandbox-runtime";

type SandboxToolContext = BackofficeToolContext<{ sandbox?: SandboxRuntime }>;

const nonEmptyString = z.string().trim().min(1);

const sandboxStatusSchema = z.enum(["running", "stopped", "error"]);
const sandboxSummarySchema = z.object({ id: nonEmptyString, status: sandboxStatusSchema });
const startInputSchema = z.object({
  id: nonEmptyString,
  keepAlive: z.boolean().optional(),
  sleepAfter: z.union([z.string(), z.number()]).optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
  startupCommand: nonEmptyString.optional(),
});
const listInputSchema = z.object({});
const killInputSchema = z.object({ sandboxId: nonEmptyString });
const killOutputSchema = z.object({ sandboxId: nonEmptyString, killed: z.literal(true) });
const execInputSchema = z.object({
  sandboxId: nonEmptyString,
  command: nonEmptyString,
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

const defineSandboxRuntimeTool = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  tool: BackofficeRuntimeTool<TInputSchema, TOutputSchema, SandboxToolContext>,
) => defineBackofficeRuntimeTool(tool);

const readBooleanOption = (parsed: ReturnType<typeof parseCliTokens>, name: string) => {
  const value = parsed.options.get(name);
  if (typeof value === "undefined") {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new Error(`--${name} specified multiple times`);
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`--${name} must be true or false`);
};

const parseStart = (args: string[]): StartSandboxOptions => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "sandbox.start");
  return {
    id: readStringOption(parsed, "id", true)!,
    keepAlive: readBooleanOption(parsed, "keep-alive"),
    sleepAfter: readStringOption(parsed, "sleep-after"),
    startupCommand: readStringOption(parsed, "startup-command"),
    startupTimeoutMs: readIntegerOption(parsed, "startup-timeout-ms"),
  };
};

const parseList = (args: string[]) => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "sandbox.list");
  return {};
};

const parseKill = (args: string[]): SandboxKillArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "sandbox.kill");
  return { sandboxId: readStringOption(parsed, "sandbox-id", true)! };
};

const parseExec = (args: string[]): SandboxExecuteCommandArgs => {
  const parsed = parseCliTokens(args);
  assertNoPositionals(parsed, "sandbox.exec");
  return {
    sandboxId: readStringOption(parsed, "sandbox-id", true)!,
    command: readStringOption(parsed, "command", true)!,
    timeoutMs: readIntegerOption(parsed, "timeout-ms"),
  };
};

const jsonDefault = (args: string[]) => {
  const parsed = parseCliTokens(args);
  const output = readOutputOptions(parsed);
  return output.print || parsed.options.has("format") ? output : { format: "json" as const };
};

const startSandboxTool = defineSandboxRuntimeTool({
  id: "sandbox.start",
  namespace: "sandbox",
  name: "startSandbox",
  description: "Start a Cloudflare sandbox for the current organisation.",
  inputSchema: startInputSchema,
  outputSchema: sandboxSummarySchema,
  execute: async (input, context) =>
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

const listSandboxesTool = defineSandboxRuntimeTool({
  id: "sandbox.list",
  namespace: "sandbox",
  name: "listSandboxes",
  description: "List Cloudflare sandboxes for the current organisation.",
  inputSchema: listInputSchema,
  outputSchema: z.array(sandboxSummarySchema),
  execute: async (_input, context) =>
    await getSandboxRuntime(context.runtimes.sandbox).listSandboxes(),
  adapters: {
    bash: {
      command: "sandbox.list",
      help: {
        summary: "sandbox.list lists tracked Cloudflare sandboxes.",
        options: [],
        examples: ["sandbox.list --format json"],
      },
      parse: parseList,
      outputOptions: jsonDefault,
      format: (result) => ({ data: result }),
    },
  },
});

const killSandboxTool = defineSandboxRuntimeTool({
  id: "sandbox.kill",
  namespace: "sandbox",
  name: "killSandbox",
  description: "Kill a Cloudflare sandbox for the current organisation.",
  inputSchema: killInputSchema,
  outputSchema: killOutputSchema,
  execute: async (input, context) =>
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

const executeCommandTool = defineSandboxRuntimeTool({
  id: "sandbox.exec",
  namespace: "sandbox",
  name: "executeCommand",
  description: "Execute a command in a Cloudflare sandbox.",
  inputSchema: execInputSchema,
  outputSchema: commandResultSchema,
  execute: async (input, context) =>
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
  tools: sandboxRuntimeTools,
  isAvailable: (context: SandboxToolContext) => !!context.runtimes.sandbox,
});
