import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type {
  CodemodeActivation,
  CodemodeCompletion,
  CodemodeInterruption,
  CodemodeSuspensionReason,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import type { CodemodeWireError } from "@fragno-dev/codemode/execution/codemode-error-contract";
import {
  CodemodeInterruptedError,
  encodeCodemodeError,
} from "@fragno-dev/codemode/execution/codemode-errors";
import type { CodemodeToolCall } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import type { CodemodeLogLine } from "@fragno-dev/codemode/runtime-api";
import { column, idColumn, schema, type Column, type FragnoId } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import {
  withDatabase,
  type Cursor,
  type FragnoPublicConfigWithDatabase,
  type HookContext,
  type HookFn,
} from "@fragno-dev/db";

/** The Codemode object owns every activation's guest; a workflow activation is one runner tick. */
export type CodemodeRunActivation = CodemodeActivation;

/**
 * Only a workflow tick suspends or is interrupted, because only its runner tries it again; the
 * object fails any other activation that would.
 */
export type CodemodeRunCompletion<
  TActivation extends CodemodeRunActivation = CodemodeRunActivation,
> = TActivation extends { kind: "workflow" }
  ? CodemodeCompletion | CodemodeInterruption
  : Exclude<CodemodeCompletion, { status: "suspended" }>;

/** The run identity links a caller's result to its retained history. */
export type CodemodeExecution<TActivation extends CodemodeRunActivation = CodemodeRunActivation> = {
  runId: string;
  completion: CodemodeRunCompletion<TActivation>;
};

/** History and durable hooks use ISO timestamps; live completions retain the runner's Dates. */
type CodemodeRunSuspensionReason = ReturnType<typeof serializeCodemodeRunSuspensionReason>;

function serializeCodemodeRunSuspensionReason(reason: CodemodeSuspensionReason) {
  if (reason.type === "sleep" || reason.type === "waitForEvent") {
    const { runAt, ...details } = reason;
    return { ...details, ...(runAt === undefined ? {} : { runAt: runAt.toISOString() }) };
  }
  return reason;
}

type CodemodeRunOutcome =
  | { status: "completed"; logs: CodemodeLogLine[] }
  | { status: "failed"; error: CodemodeWireError; logs: CodemodeLogLine[] }
  | { status: "suspended"; reason: CodemodeRunSuspensionReason; logs: CodemodeLogLine[] };

type CodemodeActivationKind = CodemodeRunActivation["kind"];

/** A workflow run is one tick of its instance, so it always names that instance. */
type CodemodeRunActivationIdentity =
  | { activationKind: Exclude<CodemodeActivationKind, "workflow"> }
  | { activationKind: "workflow"; workflowInstanceId: string };

/** What a run executes, as named by its caller; the object never inspects guest code. */
export type CodemodeRunOrigin = { kind: "inline" } | { kind: "file"; path: string };

/**
 * Who started a run, under which scope ceiling, and what it executes; fixed when the run starts.
 * Together, actors and ceiling bound the authority the run's output was obtained with.
 */
export type CodemodeRunContext = {
  origin: CodemodeRunOrigin;
  actors: AutomationActors;
  scopeRestriction: BackofficeContextScope | null;
};

export type CodemodeRunStartedHookPayload = CodemodeRunContext &
  CodemodeRunActivationIdentity & {
    runId: string;
    startedAt: string;
  };

/** Logs stay with the run record; hook payloads are copied into the hook queue and run events. */
export type CodemodeRunFinishedHookPayload = CodemodeRunStartedHookPayload & {
  finishedAt: string;
} & (
    | { status: "completed" }
    | { status: "failed"; error: CodemodeWireError }
    | { status: "suspended"; reason: CodemodeRunSuspensionReason }
  );

/** Hooks fire after their run transition commits and retry until the handler succeeds. */
export type CodemodeFragmentConfig = {
  onRunStarted: (payload: CodemodeRunStartedHookPayload, context: HookContext) => Promise<void>;
  onRunFinished: (payload: CodemodeRunFinishedHookPayload, context: HookContext) => Promise<void>;
};

type CodemodeHooksMap = {
  onRunStarted: HookFn<CodemodeRunStartedHookPayload>;
  onRunFinished: HookFn<CodemodeRunFinishedHookPayload>;
  expireRunToolCalls: HookFn<{ runId: string }>;
};

/** A run is persisted before its guest starts; a run without an outcome never reported finishing. */
export type CodemodeRun = CodemodeRunContext &
  CodemodeRunActivationIdentity & {
    id: string;
    createdAt: string;
  } & ({ status: "running" } | CodemodeRunOutcome);

/** A continuation cursor already fixes its page size. */
export type CodemodeRunPageInput =
  | { page: "first"; pageSize: number }
  | { page: "next"; cursor: string };

export type CodemodeRunPage = {
  runs: CodemodeRun[];
  cursor: string | null;
  hasNextPage: boolean;
};

/**
 * A run's tool call, recorded when the guest makes it; a run can end before its calls settle. Input
 * and output are bounded summaries, and the output of a failed call is its error message.
 */
export type CodemodeRunToolCall = CodemodeToolCall & { input: string; calledAt: string } & (
    | { status: "running" }
    | CodemodeToolCallSettlement
  );

export type CodemodeToolCallSettlement = {
  status: "succeeded" | "failed";
  output: string;
  settledAt: string;
};

/**
 * A run with everything it recorded. Guests are short, so the calls come whole; a guest stuck in a
 * loop of calls is cut off at the first {@link CODEMODE_RUN_MAX_TOOL_CALLS}.
 */
export type CodemodeRunDetail = CodemodeRun & {
  toolCalls: CodemodeRunToolCall[];
  toolCallsTruncated: boolean;
};

export const CODEMODE_RUN_ORDER_INDEX = "idx_codemode_run_createdAt";
const CODEMODE_TOOL_CALL_ORDER_INDEX = "idx_codemode_tool_call_run_sequence";
const CODEMODE_RUN_MAX_TOOL_CALLS = 200;
const CODEMODE_RUN_RETENTION_DAYS = 7;
// Activations end within minutes, so a run's calls are settled long before they expire.
const CODEMODE_TOOL_CALL_RETENTION_DAYS = 7;
const CODEMODE_TOOL_CALL_EXPIRY_BATCH_SIZE = 100;
// Each new run removes a bounded batch of expired runs, so retention needs no scheduler.
const CODEMODE_RUN_EXPIRY_BATCH_SIZE = 32;

const codemodeSchema = schema("codemode", (s) =>
  s
    .addTable("run", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn(
          "activationKind",
          column("string") as Column<"string", CodemodeActivationKind, CodemodeActivationKind>,
        )
        .addColumn("origin", column("json") as Column<"json", CodemodeRunOrigin, CodemodeRunOrigin>)
        .addColumn("actors", column("json") as Column<"json", AutomationActors, AutomationActors>)
        .addColumn(
          "scopeRestriction",
          (
            column("json") as Column<"json", BackofficeContextScope, BackofficeContextScope>
          ).nullable(),
        )
        // Logs are already bounded by the executor, so the outcome is stored with its run.
        .addColumn(
          "outcome",
          (column("json") as Column<"json", CodemodeRunOutcome, CodemodeRunOutcome>).nullable(),
        )
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex(CODEMODE_RUN_ORDER_INDEX, ["createdAt", "id"]),
    )
    .alterTable("run", (t) =>
      // Runs started before billing were billed to nobody.
      t.addColumn("billingOrganizationId", column("string").nullable()),
    )
    .alterTable("run", (t) => t.dropColumn("billingOrganizationId"))

    .alterTable("run", (t) => t.addColumn("workflowInstanceId", column("string").nullable()))
    .addTable("tool_call", (t) =>
      t
        .addColumn("id", idColumn())
        // Not a reference: calls and runs expire independently, so neither waits on the other.
        .addColumn("runId", column("string"))
        .addColumn(
          "scope",
          column("json") as Column<"json", CodemodeToolCall["scope"], CodemodeToolCall["scope"]>,
        )
        .addColumn("provider", column("string"))
        .addColumn("tool", column("string"))
        // Orders a run's calls as its guest made them; parallel calls share a calledAt.
        .addColumn("sequence", column("integer"))
        .addColumn("input", column("string"))
        .addColumn(
          "status",
          column("string") as Column<
            "string",
            CodemodeRunToolCall["status"],
            CodemodeRunToolCall["status"]
          >,
        )
        .addColumn(
          "calledAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        // Set exactly when status leaves running.
        .addColumn("output", column("string").nullable())
        .addColumn("settledAt", column("timestamp").nullable())
        .createIndex(CODEMODE_TOOL_CALL_ORDER_INDEX, ["runId", "sequence"]),
    ),
);

function codemodeRunToolCallFromRecord(record: {
  scope: CodemodeToolCall["scope"];
  provider: string;
  tool: string;
  input: string;
  status: CodemodeRunToolCall["status"];
  output: string | null;
  calledAt: Date;
  settledAt: Date | null;
}): CodemodeRunToolCall {
  const call = {
    scope: record.scope,
    provider: record.provider,
    tool: record.tool,
    input: record.input,
    calledAt: record.calledAt.toISOString(),
  };
  return record.status === "running"
    ? { ...call, status: "running" }
    : {
        ...call,
        status: record.status,
        output: record.output!,
        settledAt: record.settledAt!.toISOString(),
      };
}

function codemodeRunActivationIdentity(record: {
  activationKind: CodemodeActivationKind;
  workflowInstanceId: string | null;
}): CodemodeRunActivationIdentity {
  return record.activationKind === "workflow"
    ? // startRun stores the instance with every workflow run.
      { activationKind: "workflow", workflowInstanceId: record.workflowInstanceId! }
    : { activationKind: record.activationKind };
}

function codemodeRunFromRecord(record: {
  id: FragnoId;
  activationKind: CodemodeActivationKind;
  origin: CodemodeRunOrigin;
  actors: AutomationActors;
  scopeRestriction: BackofficeContextScope | null;
  workflowInstanceId: string | null;
  outcome: CodemodeRunOutcome | null;
  createdAt: Date;
}): CodemodeRun {
  const run = {
    id: record.id.valueOf(),
    ...codemodeRunActivationIdentity(record),
    origin: record.origin,
    actors: record.actors,
    scopeRestriction: record.scopeRestriction,
    createdAt: record.createdAt.toISOString(),
  };
  return record.outcome === null ? { ...run, status: "running" } : { ...run, ...record.outcome };
}

const codemodeFragmentDefinition = defineFragment<CodemodeFragmentConfig>("codemode")
  .extend(withDatabase(codemodeSchema))
  .provideHooks<CodemodeHooksMap>(({ defineHook, config }) => ({
    onRunStarted: defineHook(async function (payload) {
      await config.onRunStarted(payload, this);
    }),
    onRunFinished: defineHook(async function (payload) {
      await config.onRunFinished(payload, this);
    }),
    expireRunToolCalls: defineHook(async function ({ runId }) {
      // Bounded batches keep a run with many calls from becoming one oversized transaction.
      let deleted: number;
      do {
        deleted = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(codemodeSchema).find("tool_call", (b) =>
              b
                .whereIndex(CODEMODE_TOOL_CALL_ORDER_INDEX, (eb) => eb("runId", "=", runId))
                .pageSize(CODEMODE_TOOL_CALL_EXPIRY_BATCH_SIZE)
                .select(["id"]),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [calls] }) => {
            if (calls.length > 0) {
              forSchema(codemodeSchema).deleteMany(
                "tool_call",
                calls.map((call) => call.id),
              );
            }
            return calls.length;
          })
          .execute();
      } while (deleted === CODEMODE_TOOL_CALL_EXPIRY_BATCH_SIZE);
    }),
  }))
  .providesBaseService(({ defineService }) =>
    defineService({
      startRun: function (
        activation: CodemodeRunActivation,
        context: CodemodeRunContext,
        startedAt: Date,
      ) {
        const identity: CodemodeRunActivationIdentity =
          activation.kind === "workflow"
            ? { activationKind: "workflow", workflowInstanceId: activation.event.instanceId }
            : { activationKind: activation.kind };
        return this.serviceTx(codemodeSchema)
          .retrieve((uow) =>
            uow.find("run", (b) =>
              b
                .whereIndex(CODEMODE_RUN_ORDER_INDEX, (eb) =>
                  eb("createdAt", "<", eb.now().plus({ days: -CODEMODE_RUN_RETENTION_DAYS })),
                )
                .pageSize(CODEMODE_RUN_EXPIRY_BATCH_SIZE)
                .select(["id"]),
            ),
          )
          .mutate(({ uow, retrieveResult: [expiredRuns] }) => {
            if (expiredRuns.length > 0) {
              uow.deleteMany(
                "run",
                expiredRuns.map((run) => run.id),
              );
            }
            const runId = uow
              .create("run", {
                activationKind: identity.activationKind,
                workflowInstanceId:
                  identity.activationKind === "workflow" ? identity.workflowInstanceId : null,
                ...context,
                outcome: null,
                createdAt: startedAt,
              })
              .valueOf();
            uow.triggerHook("onRunStarted", {
              ...context,
              ...identity,
              runId,
              startedAt: startedAt.toISOString(),
            });
            uow.triggerHook(
              "expireRunToolCalls",
              { runId },
              { processAt: uow.now().plus({ days: CODEMODE_TOOL_CALL_RETENTION_DAYS }) },
            );
            return runId;
          })
          .build();
      },

      finishRun: function (runId: string, completion: CodemodeRunCompletion, finishedAt: Date) {
        const outcome: CodemodeRunOutcome =
          completion.status === "completed"
            ? { status: "completed", logs: completion.logs }
            : completion.status === "failed"
              ? { status: "failed", error: completion.error, logs: completion.logs }
              : completion.status === "interrupted"
                ? {
                    // History shows the tick as failed; its runner tries it again.
                    status: "failed",
                    error: encodeCodemodeError(new CodemodeInterruptedError(completion.cause)),
                    logs: [],
                  }
                : {
                    status: "suspended",
                    reason: serializeCodemodeRunSuspensionReason(completion.reason),
                    logs: completion.logs,
                  };
        return this.serviceTx(codemodeSchema)
          .retrieve((uow) =>
            uow.findFirst("run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId))),
          )
          .mutate(({ uow, retrieveResult: [run] }) => {
            if (!run) {
              throw new Error(`CODEMODE_RUN_NOT_FOUND: ${runId}`);
            }
            uow.update("run", run.id, (b) => b.set({ outcome }));
            const finished = {
              origin: run.origin,
              actors: run.actors,
              scopeRestriction: run.scopeRestriction,
              runId,
              ...codemodeRunActivationIdentity(run),
              startedAt: run.createdAt.toISOString(),
              finishedAt: finishedAt.toISOString(),
            };
            uow.triggerHook(
              "onRunFinished",
              outcome.status === "completed"
                ? { ...finished, status: "completed" }
                : outcome.status === "failed"
                  ? { ...finished, status: "failed", error: outcome.error }
                  : { ...finished, status: "suspended", reason: outcome.reason },
            );
          })
          .build();
      },

      /** `sequence` is the call's position among its run's calls, counting from 0. */
      startToolCall: function (
        runId: string,
        sequence: number,
        call: CodemodeToolCall,
        input: string,
      ) {
        return this.serviceTx(codemodeSchema)
          .mutate(({ uow }) =>
            uow
              .create("tool_call", {
                runId,
                sequence,
                ...call,
                input,
                status: "running",
                output: null,
                settledAt: null,
              })
              .valueOf(),
          )
          .build();
      },

      settleToolCall: function (
        callId: string,
        settlement: Omit<CodemodeToolCallSettlement, "settledAt">,
      ) {
        return this.serviceTx(codemodeSchema)
          .mutate(({ uow }) => {
            uow.update("tool_call", callId, (b) => b.set({ ...settlement, settledAt: uow.now() }));
          })
          .build();
      },

      getRun: function (runId: string) {
        return this.serviceTx(codemodeSchema)
          .retrieve((uow) =>
            uow
              .findFirst("run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId)))
              .findWithCursor("tool_call", (b) =>
                b
                  .whereIndex(CODEMODE_TOOL_CALL_ORDER_INDEX, (eb) => eb("runId", "=", runId))
                  .orderByIndex(CODEMODE_TOOL_CALL_ORDER_INDEX, "asc")
                  .pageSize(CODEMODE_RUN_MAX_TOOL_CALLS),
              ),
          )
          .transformRetrieve(
            ([run, toolCalls]): CodemodeRunDetail | null =>
              run && {
                ...codemodeRunFromRecord(run),
                toolCalls: toolCalls.items.map(codemodeRunToolCallFromRecord),
                toolCallsTruncated: toolCalls.hasNextPage,
              },
          )
          .build();
      },

      listRuns: function (
        input: { page: "first"; pageSize: number } | { page: "next"; cursor: Cursor },
      ) {
        return this.serviceTx(codemodeSchema)
          .retrieve((uow) =>
            uow.findWithCursor("run", (b) => {
              const ordered = b
                .whereIndex(CODEMODE_RUN_ORDER_INDEX)
                .orderByIndex(CODEMODE_RUN_ORDER_INDEX, "desc");
              return input.page === "first"
                ? ordered.pageSize(input.pageSize)
                : ordered.after(input.cursor);
            }),
          )
          .transformRetrieve(
            ([page]): CodemodeRunPage => ({
              runs: page.items.map(codemodeRunFromRecord),
              cursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }),
          )
          .build();
      },
    }),
  )
  .build();

/** Run history for one Backoffice scope; execution itself is owned by the hosting Codemode object. */
export function createCodemodeFragment(
  config: CodemodeFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(codemodeFragmentDefinition)
    .withConfig(config)
    .withRoutes([])
    .withOptions(options)
    .build();
}

export type CodemodeFragment = ReturnType<typeof createCodemodeFragment>;
