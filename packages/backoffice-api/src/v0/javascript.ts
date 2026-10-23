import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

/** One console call, unprefixed; `codemode` lines come from the runtime rather than the guest. */
const javaScriptLogLineSchema = z.lazy(() =>
  z.object({
    at: z.number().int(),
    channel: z.enum(["log", "info", "debug", "warn", "error", "codemode"]),
    text: z.string(),
  }),
);

const javaScriptCheckDiagnosticSchema = z.lazy(() =>
  z.object({
    code: z.number().int(),
    path: z.string().nullable(),
    line: z.number().int().positive().nullable(),
    column: z.number().int().positive().nullable(),
    message: z.string(),
  }),
);

export const javaScriptBuildInputSchema = z.lazy(() =>
  z.strictObject({
    path: z.string().trim().min(1),
    out: z.string().trim().min(1),
  }),
);

// `rejected` means no build run was recorded; the other outcomes name their run for js.runs.get.
const javaScriptBuildOutputSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("success"),
      path: z.string(),
      outputPath: z.string(),
      runId: z.string(),
      warnings: z.array(z.string()),
    }),
    z.strictObject({
      status: z.literal("error"),
      path: z.string(),
      outputPath: z.string(),
      runId: z.string(),
      error: z.string(),
    }),
    z.strictObject({
      status: z.literal("rejected"),
      path: z.string(),
      outputPath: z.string(),
      error: z.string(),
    }),
  ]),
);

const javaScriptCheckOutputSchema = z.lazy(() =>
  z.object({
    path: z.string(),
    valid: z.boolean(),
    diagnostics: z.array(javaScriptCheckDiagnosticSchema),
  }),
);

const javaScriptFileInputSchema = z.lazy(() =>
  z.object({
    path: z.string().trim().min(1),
  }),
);

// `rejected` means no run result: the file was refused or execution could not start or report.
const javaScriptRunOutputSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("success"),
      path: z.string(),
      runId: z.string(),
      logs: z.array(javaScriptLogLineSchema),
    }),
    z.object({
      status: z.literal("error"),
      path: z.string(),
      runId: z.string(),
      error: z.string(),
      logs: z.array(javaScriptLogLineSchema),
    }),
    z.object({
      status: z.literal("rejected"),
      path: z.string(),
      error: z.string(),
    }),
  ]),
);

export const javaScriptRunsListInputSchema = z.lazy(() =>
  z
    .strictObject({
      limit: z.number().int().positive().max(20).optional(),
      cursor: z.string().trim().min(1).optional(),
    })
    .refine((input) => input.limit === undefined || input.cursor === undefined, {
      message: "A cursor already fixes its page size.",
    }),
);

export type JavaScriptRunsListInput = z.infer<typeof javaScriptRunsListInputSchema>;

/** What a run executed and when it started; the same for every listed or inspected run. */
const javaScriptRunSummaryShape = {
  runId: z.string(),
  activation: z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["immediate", "module", "module-build", "compiled"]) }),
    z.object({ kind: z.literal("workflow"), workflowInstanceId: z.string() }),
  ]),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inline") }),
    z.object({ kind: z.literal("file"), path: z.string() }),
  ]),
  startedAt: z.string(),
};

// Logs, errors, and tool calls stay behind js.runs.get; a listing only says what ran and how it ended.
const javaScriptRunsListOutputSchema = z.lazy(() =>
  z.object({
    runs: z.array(
      z.object({
        ...javaScriptRunSummaryShape,
        status: z.enum(["running", "completed", "failed", "suspended"]),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
);

export const javaScriptRunsGetInputSchema = z.lazy(() =>
  z.strictObject({
    runId: z.string().trim().min(1),
  }),
);

/** `current` is the run's own scope; a `context` handle names another. */
const javaScriptToolCallScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("org"), orgId: z.string() }),
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("project"), projectId: z.string() }),
]);

const javaScriptToolCallShape = {
  scope: javaScriptToolCallScopeSchema,
  provider: z.string(),
  tool: z.string(),
  input: z.string(),
  calledAt: z.string(),
};

/**
 * Input and output are JSON summaries cut to 500 characters; a failed call's output is its error, and
 * tools that return credentials store `[redacted]`. A running call may never settle if its run ended.
 */
const javaScriptToolCallSchema = z.discriminatedUnion("status", [
  z.object({ ...javaScriptToolCallShape, status: z.literal("running") }),
  z.object({
    ...javaScriptToolCallShape,
    status: z.enum(["succeeded", "failed"]),
    output: z.string(),
    settledAt: z.string(),
  }),
]);

const javaScriptRunDetailShape = {
  ...javaScriptRunSummaryShape,
  // Oldest first; truncated after the first 200, when a guest calls tools in a loop.
  toolCalls: z.array(javaScriptToolCallSchema),
  toolCallsTruncated: z.boolean(),
};

// A running run has no logs yet: they are stored with its outcome.
const javaScriptRunsGetOutputSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.object({ ...javaScriptRunDetailShape, status: z.literal("running") }),
    z.object({
      ...javaScriptRunDetailShape,
      status: z.literal("completed"),
      logs: z.array(javaScriptLogLineSchema),
    }),
    z.object({
      ...javaScriptRunDetailShape,
      status: z.literal("failed"),
      logs: z.array(javaScriptLogLineSchema),
      error: z.string(),
    }),
    // A workflow tick ends suspended when its workflow waits; the runner resumes it in a new run.
    z.object({
      ...javaScriptRunDetailShape,
      status: z.literal("suspended"),
      logs: z.array(javaScriptLogLineSchema),
    }),
  ]),
);

export const javascriptOperations = {
  "js.build": {
    description:
      "Compile a saved JavaScript ES module into a reusable built JSON module under /workspace without executing or activating it. Consumers validate exports.",
    permissions: [BACKOFFICE_PERMISSION.upload.read, BACKOFFICE_PERMISSION.upload.modify],
    input: javaScriptBuildInputSchema,
    output: javaScriptBuildOutputSchema,
  },
  "js.check": {
    description:
      "Type check a standalone JavaScript file under /static or /workspace against static declarations.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: javaScriptFileInputSchema,
    output: javaScriptCheckOutputSchema,
  },
  "js.runs.list": {
    description:
      "List codemode runs in the current scope, newest first, with their status and what they ran. Lists only runs readable with js.runs.get, so a page can hold fewer runs than its limit (1-20; defaults to 20). Runs are kept for 7 days.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: javaScriptRunsListInputSchema,
    output: javaScriptRunsListOutputSchema,
  },
  "js.runs.get": {
    description:
      "Show one codemode run in the current scope: its outcome, console logs, and every tool call it made with summaries of their input and output, recorded as they happen. Readable only with at least the authority the run had: same principal, no extra delegation, no narrower scope restriction. Runs are kept for 7 days.",
    // The runtime also requires the reader to hold at least the run's authority.
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: javaScriptRunsGetInputSchema,
    output: javaScriptRunsGetOutputSchema,
  },
  "js.run": {
    description:
      "Run top-level statements in a saved .js source file or a built .json module under /static or /workspace. Ignores exports; built modules run without compilation and startup errors are returned.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: javaScriptFileInputSchema,
    output: javaScriptRunOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
