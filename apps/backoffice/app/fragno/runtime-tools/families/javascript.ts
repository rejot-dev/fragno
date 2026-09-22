import { z } from "zod";

import {
  parseCliTokens,
  readOutputOptions,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";
import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import type {
  JavaScriptCheckFileOutput,
  JavaScriptRunFileOutput,
  JavaScriptRuntime,
} from "./javascript-runtime";

const javaScriptFileInputSchema = z.object({
  path: z.string().trim().min(1),
});
const javaScriptCheckDiagnosticSchema = z.object({
  code: z.number().int(),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  message: z.string(),
});
const javaScriptCheckOutputSchema = z.object({
  path: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(javaScriptCheckDiagnosticSchema),
});
const javaScriptRunOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    path: z.string(),
    logs: z.array(z.string()),
  }),
  z.object({
    status: z.literal("error"),
    path: z.string(),
    error: z.string(),
    logs: z.array(z.string()),
  }),
]);

type JavaScriptToolContext = BackofficeToolContext<{
  javascript?: JavaScriptRuntime;
}>;

function getJavaScriptRuntime(context: JavaScriptToolContext) {
  if (!context.runtimes.javascript) {
    throw new Error("JavaScript runtime is not available in this execution context.");
  }
  return context.runtimes.javascript;
}

function getJavaScriptCheckFile(context: JavaScriptToolContext) {
  const checkFile = getJavaScriptRuntime(context).checkFile;
  if (!checkFile) {
    throw new Error("JavaScript checking is not available in this execution context.");
  }
  return checkFile;
}

function getJavaScriptRunFile(context: JavaScriptToolContext) {
  const runFile = getJavaScriptRuntime(context).runFile;
  if (!runFile) {
    throw new Error("JavaScript execution is not available in this execution context.");
  }
  return runFile;
}

const STANDARD_JAVASCRIPT_COMMAND_OPTIONS = new Set(["help", "print", "format", "json"]);

function parseJavaScriptFileCommand(command: string, args: string[]) {
  const parsed = parseCliTokens(args);
  for (const option of parsed.options.keys()) {
    if (!STANDARD_JAVASCRIPT_COMMAND_OPTIONS.has(option)) {
      throw new Error(`${command} does not accept option --${option}`);
    }
  }
  if (parsed.positionals.length !== 1) {
    throw new Error(`${command} requires exactly one JavaScript file path`);
  }
  return { path: parsed.positionals[0] };
}

function formatJavaScriptCheckOutput(
  output: JavaScriptCheckFileOutput,
  options: ReturnType<typeof readOutputOptions>,
) {
  if (options.format === "json" || options.print) {
    return { data: output, ...(output.valid ? {} : { exitCode: 1 }) };
  }
  if (output.valid) {
    return { stdout: `${output.path}: no TypeScript errors\n` };
  }
  return {
    stderr: `${output.diagnostics
      .map((diagnostic) => {
        const location =
          diagnostic.path && diagnostic.line && diagnostic.column
            ? `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} `
            : "";
        return `${location}TS${diagnostic.code}: ${diagnostic.message}`;
      })
      .join("\n")}\n`,
    exitCode: 1,
  };
}

function formatJavaScriptRunOutput(
  output: JavaScriptRunFileOutput,
  options: ReturnType<typeof readOutputOptions>,
) {
  if (options.format === "json" || options.print) {
    return { data: output, ...(output.status === "error" ? { exitCode: 1 } : {}) };
  }

  const stdout = output.logs.length > 0 ? `${output.logs.join("\n")}\n` : "";
  if (output.status === "error") {
    return { stdout, stderr: `${output.error}\n`, exitCode: 1 };
  }
  return { stdout };
}

const javaScriptCheckTool = defineBackofficeRuntimeTool({
  id: "js.check",
  namespace: "js",
  name: "check",
  authorizationNamespace: "upload",
  description:
    "Type check a standalone JavaScript file under /static or /workspace against static declarations.",
  requiredPermissions: ["read"],
  inputSchema: javaScriptFileInputSchema,
  outputSchema: javaScriptCheckOutputSchema,
  execute: async (input, context: JavaScriptToolContext) =>
    await getJavaScriptCheckFile(context)(input),
  adapters: {
    bash: {
      command: "js.check",
      help: {
        summary:
          "js.check checks a standalone /static or /workspace JavaScript file with TypeScript.",
        usage: "js.check <file> [options]",
        options: [],
        examples: [
          "js.check /workspace/automations/example.workflow.js",
          "js.check /static/marketplace/example/automation.js --format json",
        ],
      },
      parse: (args) => parseJavaScriptFileCommand("js.check", args),
      outputOptions: (_args, parsed: ParsedCliTokens) => readOutputOptions(parsed),
      execute: async ({ input, context, commandOutput, shell }) => {
        const output = await getJavaScriptCheckFile(context)({
          path: shell.fs.resolvePath(shell.cwd, input.path),
        });
        return formatJavaScriptCheckOutput(output, commandOutput);
      },
    },
  },
});

const javaScriptRunTool = defineBackofficeRuntimeTool({
  id: "js.run",
  namespace: "js",
  name: "run",
  authorizationNamespace: "upload",
  description:
    "Run a standalone saved JavaScript file as an ES module under /static or /workspace.",
  requiredPermissions: ["read"],
  inputSchema: javaScriptFileInputSchema,
  outputSchema: javaScriptRunOutputSchema,
  execute: async (input, context: JavaScriptToolContext) =>
    await getJavaScriptRunFile(context)(input, context),
  adapters: {
    bash: {
      command: "js.run",
      help: {
        summary: "js.run executes top-level statements in a standalone saved JavaScript ES module.",
        usage: "js.run <file> [options]",
        options: [],
        examples: ["js.run /workspace/scripts/example.js", "js.run scripts/example.js"],
      },
      parse: (args) => parseJavaScriptFileCommand("js.run", args),
      outputOptions: (_args, parsed: ParsedCliTokens) => readOutputOptions(parsed),
      execute: async ({ input, context, commandOutput, shell }) => {
        const output = await getJavaScriptRunFile(context)(
          { path: shell.fs.resolvePath(shell.cwd, input.path) },
          context,
        );
        return formatJavaScriptRunOutput(output, commandOutput);
      },
    },
  },
});

/** Runtime tool family for checking saved JavaScript files. */
export const javaScriptCheckToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  permissions: {
    read: "Read JavaScript source and declaration files.",
  },
  tools: [javaScriptCheckTool],
  isAvailable: (context: JavaScriptToolContext) =>
    context.runtimes.javascript?.checkFile !== null &&
    context.runtimes.javascript?.checkFile !== undefined,
});

/** Runtime tool family for executing saved JavaScript files. */
export const javaScriptRunToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  permissions: {
    read: "Read JavaScript source files for execution.",
  },
  tools: [javaScriptRunTool],
  isAvailable: (context: JavaScriptToolContext) =>
    context.runtimes.javascript?.runFile !== null &&
    context.runtimes.javascript?.runFile !== undefined,
});
