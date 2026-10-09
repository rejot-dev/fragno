import { z } from "zod";

import type { BackofficeApiOperation } from "../api";

const javaScriptCheckDiagnosticSchema = z.object({
  code: z.number().int(),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  message: z.string(),
});

export const javaScriptBuildInputSchema = z.strictObject({
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

const javaScriptCheckOutputSchema = z.object({
  path: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(javaScriptCheckDiagnosticSchema),
});

const javaScriptFileInputSchema = z.object({
  path: z.string().trim().min(1),
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

export const javascriptOperations = {
  "js.build": {
    description:
      "Compile a saved JavaScript ES module into a reusable JSON artifact under /workspace without executing or activating it. Consumers validate exports.",
    input: javaScriptBuildInputSchema,
    output: javaScriptBuildOutputSchema,
  },
  "js.check": {
    description:
      "Type check a standalone JavaScript file under /static or /workspace against static declarations.",
    input: javaScriptFileInputSchema,
    output: javaScriptCheckOutputSchema,
  },
  "js.run": {
    description:
      "Run top-level statements in a saved .js source file or a built .json module artifact under /static or /workspace. Ignores exports; artifacts run without compilation and startup errors are returned.",
    input: javaScriptFileInputSchema,
    output: javaScriptRunOutputSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
