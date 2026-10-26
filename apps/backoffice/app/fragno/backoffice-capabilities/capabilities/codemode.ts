import { backofficeContextScopeSchema } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { codemodeWireErrorSchema } from "@fragno-dev/codemode/execution/codemode-error-contract";
import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

export const CODEMODE_AUTOMATION_SOURCE = "codemode" as const;
export const CODEMODE_AUTOMATION_EVENT_RUN_FAILED = "run.failed" as const;

const runFailedPayloadSchema = z.object({
  runId: z.string().trim().min(1),
  activationKind: z.enum(["immediate", "module", "module-build", "compiled"]),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inline") }),
    z.object({ kind: z.literal("file"), path: z.string().trim().min(1) }),
  ]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  status: z.literal("failed"),
  error: codemodeWireErrorSchema,
});

const runSubjectSchema = z.object({
  scope: backofficeContextScopeSchema,
  runId: z.string().trim().min(1),
});

export const codemodeCapability: BackofficeCapability = {
  id: "codemode",
  label: "Codemode",
  objectBinding: "CODEMODE",
  contributions: {
    connection: null,
    eventSources: [
      {
        source: CODEMODE_AUTOMATION_SOURCE,
        label: "Codemode",
        description: "Codemode run failures, attributed to whoever started the run.",
      },
    ],
    actionProviders: [],
    hookScopes: [
      {
        id: "codemode",
        label: "Codemode",
        getRepository: ({ objects, scope }) =>
          createDurableHookRepositoryFromCommands(objects.codemode.for(scope).commands),
      },
    ],
    skillPaths: [],
    externalEntities: [],
    automationEvents: [
      {
        source: CODEMODE_AUTOMATION_SOURCE,
        eventType: CODEMODE_AUTOMATION_EVENT_RUN_FAILED,
        label: "Codemode run failed",
        description:
          "Fires after a run fails to compile, throws, or is interrupted, with its error. js.runs.get shows its console logs and tool calls.",
        payloadSchema: runFailedPayloadSchema,
        subjectSchema: runSubjectSchema,
        example: {
          runId: "run-1",
          activationKind: "compiled",
          origin: { kind: "file", path: "/workspace/.build/report.module.json" },
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          status: "failed",
          error: {
            kind: "error",
            name: "Error",
            message: "Startup exploded",
            details: null,
            metadata: null,
          },
        },
      },
    ],
  },
};
