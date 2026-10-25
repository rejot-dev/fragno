import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const commandResultSchema = z.lazy(() =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), stdout: z.string(), stderr: z.string(), exitCode: z.number() }),
    z.object({
      ok: z.literal(false),
      code: z.string(),
      reason: z.enum([
        "authentication_failed",
        "command_failed",
        "invalid_request",
        "output_limit_exceeded",
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
  ]),
);

export const execInputSchema = z.lazy(() =>
  z.object({
    sandboxId: z.string().trim().min(1),
    command: z.string().trim().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
);

export const sandboxStatusSchema = z.lazy(() =>
  z.enum(["requested", "starting", "running", "stopping", "stopped", "error"]),
);

const sandboxImageSchema = z.lazy(() =>
  z
    .enum(["workspace", "debian"])
    .describe(
      "workspace: Debian with Node.js, Python, git, ripgrep, and jq. debian: Cloudflare-managed Debian with Node.js; starts fastest.",
    ),
);

const sandboxInstanceTypeSchema = z.lazy(() =>
  z.enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]),
);

const sandboxSummarySchema = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1),
    status: sandboxStatusSchema,
    image: sandboxImageSchema,
    instanceType: sandboxInstanceTypeSchema,
    workspaceSaved: z
      .boolean()
      .describe(
        "Whether the next start resumes the workspace saved when the sandbox last stopped.",
      ),
  }),
);

const startInputSchema = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1),
    keepAlive: z.boolean().optional(),
    sleepAfter: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        "Saves the workspace and stops the sandbox after this long, for example 15m. Defaults to 10m unless keepAlive is set.",
      ),
    startupTimeoutMs: z.number().int().positive().optional(),
    startupCommand: z.string().trim().min(1).optional(),
    image: sandboxImageSchema
      .optional()
      .describe(
        "Image for a new workspace; defaults to workspace. A saved workspace resumes on its own image.",
      ),
    instanceType: sandboxInstanceTypeSchema.optional(),
  }),
);

export const sandboxOperations = {
  "sandbox.start": {
    description: "Start a Cloudflare sandbox for the current scope.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.modify],
    input: startInputSchema,
    output: sandboxSummarySchema,
  },
  "sandbox.list": {
    description: "List Cloudflare sandboxes for the current scope.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.read],
    input: z.void(),
    output: z.lazy(() => z.array(sandboxSummarySchema)),
  },
  "sandbox.kill": {
    description:
      "Save a Cloudflare sandbox's workspace and stop it. Starting the same sandbox ID resumes the workspace.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.modify],
    input: z.lazy(() => z.object({ sandboxId: z.string().trim().min(1) })),
    output: z.lazy(() =>
      z.object({ sandboxId: z.string().trim().min(1), killed: z.literal(true) }),
    ),
  },
  "sandbox.exec": {
    description: "Execute a command in a Cloudflare sandbox.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.modify],
    input: execInputSchema,
    output: commandResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
