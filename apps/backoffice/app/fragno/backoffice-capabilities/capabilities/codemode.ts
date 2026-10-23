import { codemodeWireErrorSchema } from "@fragno-dev/codemode/execution/codemode-error-contract";
import { z } from "zod";

import type { BackofficeCapability } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import { createDurableHookRepositoryFromCommands } from "@/fragno/durable-hook-command-repository";

export const CODEMODE_AUTOMATION_SOURCE = "codemode" as const;
export const CODEMODE_AUTOMATION_EVENT_RUN_STARTED = "run.started" as const;
export const CODEMODE_AUTOMATION_EVENT_RUN_COMPLETED = "run.completed" as const;
export const CODEMODE_AUTOMATION_EVENT_RUN_FAILED = "run.failed" as const;

const runStartedPayloadSchema = z.object({
  runId: z.string().trim().min(1),
  activationKind: z.enum(["immediate", "module", "module-build", "compiled"]),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inline") }),
    z.object({ kind: z.literal("file"), path: z.string().trim().min(1) }),
  ]),
  startedAt: z.iso.datetime(),
});

const runCompletedPayloadSchema = runStartedPayloadSchema.extend({
  finishedAt: z.iso.datetime(),
  status: z.literal("completed"),
});

const runFailedPayloadSchema = runStartedPayloadSchema.extend({
  finishedAt: z.iso.datetime(),
  status: z.literal("failed"),
  error: codemodeWireErrorSchema,
});

const runSubjectSchema = z.object({
  orgId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1),
});

const runExample = {
  runId: "run-1",
  activationKind: "compiled",
  origin: { kind: "file", path: "/workspace/.build/report.module.json" },
  startedAt: "2026-01-01T00:00:00.000Z",
};

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
        description: "Codemode run lifecycle events, attributed to whoever started the run.",
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
        eventType: CODEMODE_AUTOMATION_EVENT_RUN_STARTED,
        label: "Codemode run started",
        description:
          "Fires when a run is recorded, before its code executes. A run with no later event never reported finishing.",
        payloadSchema: runStartedPayloadSchema,
        subjectSchema: runSubjectSchema,
        example: runExample,
      },
      {
        source: CODEMODE_AUTOMATION_SOURCE,
        eventType: CODEMODE_AUTOMATION_EVENT_RUN_COMPLETED,
        label: "Codemode run completed",
        description:
          "Fires after a run's code finishes. js.runs.get shows its console logs and tool calls.",
        payloadSchema: runCompletedPayloadSchema,
        subjectSchema: runSubjectSchema,
        example: {
          ...runExample,
          finishedAt: "2026-01-01T00:00:01.000Z",
          status: "completed",
        },
      },
      {
        source: CODEMODE_AUTOMATION_SOURCE,
        eventType: CODEMODE_AUTOMATION_EVENT_RUN_FAILED,
        label: "Codemode run failed",
        description:
          "Fires after a run fails to compile, throws, or is interrupted, with its error. js.runs.get shows its console logs and tool calls.",
        payloadSchema: runFailedPayloadSchema,
        subjectSchema: runSubjectSchema,
        example: {
          ...runExample,
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
