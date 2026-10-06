import { z } from "zod";

import {
  parseCliTokens,
  readOutputOptions,
  readStringOption,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";
import {
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import type {
  JavaScriptBuildFileOutput,
  JavaScriptCheckFileOutput,
  JavaScriptRunFileOutput,
  JavaScriptRuntime,
} from "./javascript-runtime";

const javaScriptFileInputSchema = z.object({
  path: z.string().trim().min(1),
});
const javaScriptBuildInputSchema = z.strictObject({
  path: z.string().trim().min(1),
  out: z.string().trim().min(1),
});
const javaScriptBuildOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("success"),
    path: z.string(),
    artifactPath: z.string(),
    warnings: z.array(z.string()),
  }),
  z.strictObject({
    status: z.literal("error"),
    path: z.string(),
    artifactPath: z.string(),
    error: z.string(),
  }),
]);
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

function getJavaScriptBuildFile(context: JavaScriptToolContext) {
  const buildFile = getJavaScriptRuntime(context).buildFile;
  if (!buildFile) {
    throw new Error("JavaScript building is not available in this execution context.");
  }
  return buildFile;
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

function formatJavaScriptBuildOutput(
  output: JavaScriptBuildFileOutput,
  options: ReturnType<typeof readOutputOptions>,
) {
  if (options.format === "json" || options.print) {
    return { data: output, ...(output.status === "error" ? { exitCode: 1 } : {}) };
  }
  if (output.status === "error") {
    return { stderr: `${output.error}\n`, exitCode: 1 };
  }
  return {
    stdout: `${output.artifactPath}\n`,
    stderr: output.warnings.length ? `${output.warnings.join("\n")}\n` : "",
  };
}

const javaScriptBuildTool = defineBackofficeRuntimeTool({
  id: "js.build",
  namespace: "js",
  name: "build",
  authorizationNamespace: "upload",
  description:
    "Compile a saved JavaScript ES module into a reusable JSON artifact under /workspace without executing or activating it. Consumers validate exports.",
  requiredPermissions: ["read", "modify"],
  inputSchema: javaScriptBuildInputSchema,
  outputSchema: javaScriptBuildOutputSchema,
  execute: async (input, context: JavaScriptToolContext) =>
    await getJavaScriptBuildFile(context)(input),
  adapters: {
    bash: {
      command: "js.build",
      help: {
        summary: "js.build bundles a JavaScript ES module without executing it.",
        usage: "js.build <file> --out <artifact> [options]",
        options: [
          {
            name: "out",
            valueName: "path",
            required: true,
            valueRequired: true,
            description: "Output JSON module artifact under /workspace.",
          },
        ],
        examples: [
          "js.build /workspace/scripts/example.js --out /workspace/.build/example.module.json",
        ],
      },
      parse: (args) => {
        const parsed = parseCliTokens(args);
        for (const option of parsed.options.keys()) {
          if (!STANDARD_JAVASCRIPT_COMMAND_OPTIONS.has(option) && option !== "out") {
            throw new Error(`js.build does not accept option --${option}`);
          }
        }
        if (parsed.positionals.length !== 1) {
          throw new Error("js.build requires exactly one JavaScript file path");
        }
        return javaScriptBuildInputSchema.parse({
          path: parsed.positionals[0],
          out: readStringOption(parsed, "out", true),
        });
      },
      outputOptions: (_args, parsed: ParsedCliTokens) => readOutputOptions(parsed),
      execute: async ({ input, context, commandOutput, shell }) => {
        const output = await getJavaScriptBuildFile(context)({
          ...input,
          path: shell.fs.resolvePath(shell.cwd, input.path),
          out: shell.fs.resolvePath(shell.cwd, input.out),
        });
        return formatJavaScriptBuildOutput(output, commandOutput);
      },
    },
  },
});

/** Building requires workspace read and write authority, unlike checking or execution. */
export const javaScriptBuildToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  permissions: { read: "Read JavaScript source.", modify: "Publish compiled module artifacts." },
  tools: [javaScriptBuildTool],
  isAvailable: (context: JavaScriptToolContext) => Boolean(context.runtimes.javascript?.buildFile),
});

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
    "Run top-level statements in a saved .js source file or a built .json module artifact under /static or /workspace. Ignores exports; artifacts run without compilation and startup errors are returned.",
  requiredPermissions: ["read"],
  inputSchema: javaScriptFileInputSchema,
  outputSchema: javaScriptRunOutputSchema,
  execute: async (input, context: JavaScriptToolContext) =>
    await getJavaScriptRunFile(context)(input, context),
  adapters: {
    bash: {
      command: "js.run",
      help: {
        summary:
          "js.run executes top-level statements in JavaScript source or a built module artifact.",
        usage: "js.run <file> [options]",
        options: [],
        examples: [
          "js.run /workspace/scripts/example.js",
          "js.run /workspace/.build/example.module.json",
          "js.run .build/example.module.json",
        ],
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

/** Runtime tool family for executing JavaScript source and precompiled module artifacts. */
export const javaScriptRunToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  permissions: {
    read: "Read JavaScript source or module artifacts for execution.",
  },
  tools: [javaScriptRunTool],
  isAvailable: (context: JavaScriptToolContext) =>
    context.runtimes.javascript?.runFile !== null &&
    context.runtimes.javascript?.runFile !== undefined,
});
