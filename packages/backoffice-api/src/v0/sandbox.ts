import { z } from "zod";

import type { BackofficeApiOperation } from "../api";
import { BACKOFFICE_PERMISSION } from "./shared/permissions";

export const commandResultSchema = z.discriminatedUnion("ok", [
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
]);

export const execInputSchema = z.object({
  sandboxId: z.string().trim().min(1),
  command: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

export const sandboxStatusSchema = z.enum([
  "requested",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
]);

const startInputSchema = z.object({
  id: z.string().trim().min(1),
  keepAlive: z.boolean().optional(),
  sleepAfter: z.union([z.string(), z.number()]).optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
  startupCommand: z.string().trim().min(1).optional(),
});

export const sandboxOperations = {
  "sandbox.start": {
    description: "Start a Cloudflare sandbox for the current organization.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.modify],
    input: startInputSchema,
    output: z.object({
      id: z.string().trim().min(1),
      status: sandboxStatusSchema,
    }),
  },
  "sandbox.list": {
    description: "List Cloudflare sandboxes for the current organization.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.read],
    input: z.void(),
    output: z.array(z.object({ id: z.string().trim().min(1), status: sandboxStatusSchema })),
  },
  "sandbox.kill": {
    description: "Kill a Cloudflare sandbox for the current organization.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.modify],
    input: z.object({ sandboxId: z.string().trim().min(1) }),
    output: z.object({ sandboxId: z.string().trim().min(1), killed: z.literal(true) }),
  },
  "sandbox.exec": {
    description: "Execute a command in a Cloudflare sandbox.",
    permissions: [BACKOFFICE_PERMISSION.sandbox.modify],
    input: execInputSchema,
    output: commandResultSchema,
  },
} satisfies Record<string, BackofficeApiOperation>;
