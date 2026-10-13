import {
  javaScriptBuildInputSchema,
  javaScriptLogsInputSchema,
} from "@fragno-dev/backoffice-api/v0/javascript";
import { formatCodemodeLogLine, type CodemodeLogLine } from "@fragno-dev/codemode/runtime-api";

import {
  parseCliTokens,
  readOutputOptions,
  readStringOption,
  type ParsedCliTokens,
} from "@/fragno/runtime-tools/bash-cli";
import {
  backofficeApiOperationToolFields,
  defineBackofficeRuntimeTool,
  defineBackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";

import type {
  JavaScriptBuildFileOutput,
  JavaScriptCheckFileOutput,
  JavaScriptRunFileOutput,
  JavaScriptRunLogsOutput,
  JavaScriptRuntime,
} from "./javascript-runtime";

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

function getJavaScriptReadRunLogs(context: JavaScriptToolContext) {
  const readRunLogs = getJavaScriptRuntime(context).readRunLogs;
  if (!readRunLogs) {
    throw new Error("Codemode run logs are not available in this execution context.");
  }
  return readRunLogs;
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

function formatLogs(logs: CodemodeLogLine[]) {
  return logs.map((line) => `${formatCodemodeLogLine(line)}\n`).join("");
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
    return { data: output, ...(output.status === "success" ? {} : { exitCode: 1 }) };
  }
  if (output.status === "rejected") {
    return { stderr: `${output.error}\n`, exitCode: 1 };
  }

  const stdout = formatLogs(output.logs);
  if (output.status === "error") {
    return { stdout, stderr: `${output.error}\n`, exitCode: 1 };
  }
  return { stdout };
}

function formatJavaScriptRunLogsOutput(
  output: JavaScriptRunLogsOutput,
  options: ReturnType<typeof readOutputOptions>,
) {
  if (options.format === "json" || options.print) {
    return { data: output, ...(output.status === "failed" ? { exitCode: 1 } : {}) };
  }
  if (output.status === "running") {
    return { stderr: `${output.runId} is still running; its logs are stored when it finishes.\n` };
  }
  const stdout = formatLogs(output.logs);
  if (output.status === "failed") {
    return { stdout, stderr: `${output.error}\n`, exitCode: 1 };
  }
  return { stdout };
}

function formatJavaScriptBuildOutput(
  output: JavaScriptBuildFileOutput,
  options: ReturnType<typeof readOutputOptions>,
) {
  if (options.format === "json" || options.print) {
    return { data: output, ...(output.status === "success" ? {} : { exitCode: 1 }) };
  }
  if (output.status !== "success") {
    return { stderr: `${output.error}\n`, exitCode: 1 };
  }
  return {
    stdout: `${output.artifactPath}\n`,
    stderr: output.warnings.length ? `${output.warnings.join("\n")}\n` : "",
  };
}

const javaScriptBuildTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("js.build"),
  namespace: "js",
  name: "build",
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
  tools: [javaScriptBuildTool],
  isAvailable: (context: JavaScriptToolContext) => Boolean(context.runtimes.javascript?.buildFile),
});

const javaScriptCheckTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("js.check"),
  namespace: "js",
  name: "check",
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
  ...backofficeApiOperationToolFields("js.run"),
  namespace: "js",
  name: "run",
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
  tools: [javaScriptCheckTool],
  isAvailable: (context: JavaScriptToolContext) =>
    context.runtimes.javascript?.checkFile !== null &&
    context.runtimes.javascript?.checkFile !== undefined,
});

/** Runtime tool family for executing JavaScript source and precompiled module artifacts. */
export const javaScriptRunToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  tools: [javaScriptRunTool],
  isAvailable: (context: JavaScriptToolContext) =>
    context.runtimes.javascript?.runFile !== null &&
    context.runtimes.javascript?.runFile !== undefined,
});

const javaScriptLogsTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("js.logs"),
  namespace: "js",
  name: "logs",
  execute: async (input, context: JavaScriptToolContext) =>
    await getJavaScriptReadRunLogs(context)(input),
  adapters: {
    bash: {
      command: "js.logs",
      help: {
        summary: "js.logs prints the console logs of a codemode run in the current scope.",
        usage: "js.logs <run-id> [options]",
        options: [],
        examples: ["js.logs run-1", "js.logs run-1 --format json"],
      },
      parse: (args) => {
        const parsed = parseCliTokens(args);
        for (const option of parsed.options.keys()) {
          if (!STANDARD_JAVASCRIPT_COMMAND_OPTIONS.has(option)) {
            throw new Error(`js.logs does not accept option --${option}`);
          }
        }
        if (parsed.positionals.length !== 1) {
          throw new Error("js.logs requires exactly one run ID");
        }
        return javaScriptLogsInputSchema.parse({ runId: parsed.positionals[0] });
      },
      outputOptions: (_args, parsed: ParsedCliTokens) => readOutputOptions(parsed),
      execute: async ({ input, context, commandOutput }) => {
        const output = await getJavaScriptReadRunLogs(context)(input);
        return formatJavaScriptRunLogsOutput(output, commandOutput);
      },
    },
  },
});

/** Runtime tool family for reading the logs of past codemode runs. */
export const javaScriptLogsToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  tools: [javaScriptLogsTool],
  isAvailable: (context: JavaScriptToolContext) =>
    Boolean(context.runtimes.javascript?.readRunLogs),
});
