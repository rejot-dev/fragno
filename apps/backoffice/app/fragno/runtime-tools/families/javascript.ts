import {
  javaScriptBuildInputSchema,
  javaScriptRunsGetInputSchema,
  type JavaScriptRunsListInput,
} from "@fragno-dev/backoffice-api/v0/javascript";
import { formatCodemodeLogLine, type CodemodeLogLine } from "@fragno-dev/codemode/runtime-api";

import {
  defineCliArgsParser,
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
  JavaScriptRunsGetOutput,
  JavaScriptRunsListOutput,
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

function getJavaScriptRunHistory(context: JavaScriptToolContext) {
  const runHistory = getJavaScriptRuntime(context).runHistory;
  if (!runHistory) {
    throw new Error("Codemode run history is not available in this execution context.");
  }
  return runHistory;
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
    stdout: `${output.outputPath}\n`,
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
        usage: "js.build <file> --out <module.json> [options]",
        options: [
          {
            name: "out",
            valueName: "path",
            required: true,
            valueRequired: true,
            description: "Output built JSON module under /workspace.",
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
        summary: "js.run executes top-level statements in JavaScript source or a built module.",
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

/** Runtime tool family for executing JavaScript source and precompiled modules. */
export const javaScriptRunToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  tools: [javaScriptRunTool],
  isAvailable: (context: JavaScriptToolContext) =>
    context.runtimes.javascript?.runFile !== null &&
    context.runtimes.javascript?.runFile !== undefined,
});

function formatJavaScriptRunsListOutput(
  output: JavaScriptRunsListOutput,
  options: ReturnType<typeof readOutputOptions>,
) {
  if (options.format === "json" || options.print) {
    return { data: output };
  }
  const rows = output.runs.map((run) =>
    [
      run.runId,
      run.startedAt,
      run.status,
      run.activation.kind,
      run.origin.kind === "file" ? run.origin.path : "inline",
    ].join("\t"),
  );
  const nextCursor = output.nextCursor === null ? "" : `next cursor: ${output.nextCursor}\n`;
  return {
    stdout: `${["run id\tstarted at\tstatus\tactivation\torigin", ...rows].join("\n")}\n${nextCursor}`,
  };
}

function formatJavaScriptRunsGetOutput(
  output: JavaScriptRunsGetOutput,
  options: ReturnType<typeof readOutputOptions>,
) {
  if (options.format === "json" || options.print) {
    return { data: output, ...(output.status === "failed" ? { exitCode: 1 } : {}) };
  }
  const origin = output.origin.kind === "file" ? output.origin.path : "inline";
  const calls = output.toolCalls.map((call) =>
    [
      call.calledAt,
      call.status,
      `${call.provider}.${call.tool}`,
      call.scope.kind === "current" ? "current" : Object.values(call.scope).join(":"),
      call.input,
      call.status === "running" ? "" : call.output,
    ].join("\t"),
  );
  const stdout = [
    `${output.runId}\t${output.status}\t${output.activation.kind}\t${origin}\tstarted ${output.startedAt}`,
    "",
    "logs:",
    output.status === "running"
      ? "(stored when the run finishes)"
      : formatLogs(output.logs).replace(/\n$/, "") || "(none)",
    "",
    "tool calls:",
    ...(calls.length === 0
      ? ["(none)"]
      : ["called at\tstatus\ttool\tscope\tinput\toutput", ...calls]),
    ...(output.toolCallsTruncated ? ["(truncated after the first 200 calls)"] : []),
  ].join("\n");
  return output.status === "failed"
    ? { stdout: `${stdout}\n`, stderr: `${output.error}\n`, exitCode: 1 }
    : { stdout: `${stdout}\n` };
}

const javaScriptRunsListTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("js.runs.list"),
  namespace: "js",
  name: "runsList",
  execute: async (input, context: JavaScriptToolContext) =>
    await getJavaScriptRunHistory(context).listRuns(input),
  adapters: {
    bash: {
      command: "js.runs.list",
      help: {
        summary: "js.runs.list lists codemode runs in the current scope, newest first.",
        usage: "js.runs.list [options]",
        options: [
          {
            name: "limit",
            valueRequired: true,
            valueName: "number",
            description: "Page size (1-20; defaults to 20).",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor returned by the previous page; it keeps that page's size.",
          },
        ],
        examples: [
          "js.runs.list",
          "js.runs.list --limit 5 --format json",
          "js.runs.list --cursor '<cursor>'",
        ],
      },
      parse: defineCliArgsParser<JavaScriptRunsListInput>("js.runs.list", {
        limit: { kind: "positiveInteger" },
        cursor: {},
      }),
      outputOptions: (_args, parsed: ParsedCliTokens) => readOutputOptions(parsed),
      format: formatJavaScriptRunsListOutput,
    },
  },
});

const javaScriptRunsGetTool = defineBackofficeRuntimeTool({
  ...backofficeApiOperationToolFields("js.runs.get"),
  namespace: "js",
  name: "runsGet",
  execute: async (input, context: JavaScriptToolContext) =>
    await getJavaScriptRunHistory(context).getRun(input),
  adapters: {
    bash: {
      command: "js.runs.get",
      help: {
        summary:
          "js.runs.get shows a codemode run's outcome, console logs, and tool calls in the current scope.",
        usage: "js.runs.get <run-id> [options]",
        options: [],
        examples: ["js.runs.get run-1", "js.runs.get run-1 --format json"],
      },
      parse: (args) => {
        const parsed = parseCliTokens(args);
        for (const option of parsed.options.keys()) {
          if (!STANDARD_JAVASCRIPT_COMMAND_OPTIONS.has(option)) {
            throw new Error(`js.runs.get does not accept option --${option}`);
          }
        }
        if (parsed.positionals.length !== 1) {
          throw new Error("js.runs.get requires exactly one run ID");
        }
        return javaScriptRunsGetInputSchema.parse({ runId: parsed.positionals[0] });
      },
      outputOptions: (_args, parsed: ParsedCliTokens) => readOutputOptions(parsed),
      format: formatJavaScriptRunsGetOutput,
    },
  },
});

/** Runtime tool family for reading past and running codemode runs. */
export const javaScriptRunHistoryToolFamily = defineBackofficeRuntimeToolFamily({
  namespace: "js",
  tools: [javaScriptRunsListTool, javaScriptRunsGetTool],
  isAvailable: (context: JavaScriptToolContext) => Boolean(context.runtimes.javascript?.runHistory),
});
