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

// `rejected` means no build run was recorded; the other outcomes name their run for js.logs.
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

export const javaScriptLogsInputSchema = z.lazy(() =>
  z.strictObject({
    runId: z.string().trim().min(1),
  }),
);

// A running run has no logs yet: they are stored with its outcome.
const javaScriptLogsOutputSchema = z.lazy(() =>
  z.discriminatedUnion("status", [
    z.object({ runId: z.string(), status: z.literal("running") }),
    z.object({
      runId: z.string(),
      status: z.literal("completed"),
      logs: z.array(javaScriptLogLineSchema),
    }),
    z.object({
      runId: z.string(),
      status: z.literal("failed"),
      logs: z.array(javaScriptLogLineSchema),
      error: z.string(),
    }),
    // A workflow tick ends suspended when its workflow waits; the runner resumes it in a new run.
    z.object({
      runId: z.string(),
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
  "js.logs": {
    description:
      "Show the console logs and outcome of a codemode run in the current scope, by run ID. Readable only with at least the authority the run had: same principal, no extra delegation, no narrower scope restriction. Codemode run events carry run IDs; runs are kept for 7 days.",
    // The runtime also requires the reader to hold at least the run's authority.
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: javaScriptLogsInputSchema,
    output: javaScriptLogsOutputSchema,
  },
  "js.run": {
    description:
      "Run top-level statements in a saved .js source file or a built .json module under /static or /workspace. Ignores exports; built modules run without compilation and startup errors are returned.",
    permissions: [BACKOFFICE_PERMISSION.upload.read],
    input: javaScriptFileInputSchema,
    output: javaScriptRunOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
