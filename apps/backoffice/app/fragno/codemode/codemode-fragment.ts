import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type {
  CodemodeActivation,
  CodemodeCompletion,
  CodemodeSuspensionReason,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import type { CodemodeWireError } from "@fragno-dev/codemode/execution/codemode-error-contract";
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

/** Only a workflow tick suspends; the object fails any other activation that tries. */
export type CodemodeRunCompletion<
  TActivation extends CodemodeRunActivation = CodemodeRunActivation,
> = TActivation extends { kind: "workflow" }
  ? CodemodeCompletion
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

export type CodemodeRunStartedHookPayload = CodemodeRunContext & {
  runId: string;
  activationKind: CodemodeActivationKind;
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
};

/** A run is persisted before its guest starts; a run without an outcome never reported finishing. */
export type CodemodeRun = CodemodeRunContext & {
  id: string;
  activationKind: CodemodeActivationKind;
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

export const CODEMODE_RUN_ORDER_INDEX = "idx_codemode_run_createdAt";
const CODEMODE_RUN_RETENTION_DAYS = 7;
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
    .alterTable("run", (t) => t.dropColumn("billingOrganizationId")),
);

function codemodeRunFromRecord(record: {
  id: FragnoId;
  activationKind: CodemodeActivationKind;
  origin: CodemodeRunOrigin;
  actors: AutomationActors;
  scopeRestriction: BackofficeContextScope | null;
  outcome: CodemodeRunOutcome | null;
  createdAt: Date;
}): CodemodeRun {
  const run = {
    id: record.id.valueOf(),
    activationKind: record.activationKind,
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
  }))
  .providesBaseService(({ defineService }) =>
    defineService({
      startRun: function (
        activationKind: CodemodeActivationKind,
        context: CodemodeRunContext,
        startedAt: Date,
      ) {
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
              .create("run", { activationKind, ...context, outcome: null, createdAt: startedAt })
              .valueOf();
            uow.triggerHook("onRunStarted", {
              ...context,
              runId,
              activationKind,
              startedAt: startedAt.toISOString(),
            });
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
              activationKind: run.activationKind,
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

      getRun: function (runId: string) {
        return this.serviceTx(codemodeSchema)
          .retrieve((uow) =>
            uow.findFirst("run", (b) => b.whereIndex("primary", (eb) => eb("id", "=", runId))),
          )
          .transformRetrieve(([run]) => (run ? codemodeRunFromRecord(run) : null))
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
