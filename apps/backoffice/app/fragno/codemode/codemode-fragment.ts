import type {
  CodemodeActivation,
  CodemodeCompletion,
  CodemodeWireError,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { column, idColumn, schema, type Column, type FragnoId } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type Cursor, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

/** Activations whose complete host lifecycle the Codemode object owns; workflows suspend through their runner. */
export type CodemodeRunActivation = Extract<
  CodemodeActivation,
  { kind: "immediate" | "module" | "module-build" | "compiled" }
>;

/** These activations cannot suspend, so a finished run either completed or failed. */
export type CodemodeRunCompletion = Exclude<CodemodeCompletion, { status: "suspended" }>;

/** The run identity links a caller's result to its retained history. */
export type CodemodeExecution = {
  runId: string;
  completion: CodemodeRunCompletion;
};

type CodemodeRunOutcome =
  | { status: "completed"; logs: string[] }
  | { status: "failed"; error: CodemodeWireError; logs: string[] };

type CodemodeActivationKind = CodemodeRunActivation["kind"];

/** A run is persisted before its guest starts; a run without an outcome never reported finishing. */
export type CodemodeRun = {
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
  s.addTable("run", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn(
        "activationKind",
        column("string") as Column<"string", CodemodeActivationKind, CodemodeActivationKind>,
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
  ),
);

function codemodeRunFromRecord(record: {
  id: FragnoId;
  activationKind: CodemodeActivationKind;
  outcome: CodemodeRunOutcome | null;
  createdAt: Date;
}): CodemodeRun {
  const run = {
    id: record.id.valueOf(),
    activationKind: record.activationKind,
    createdAt: record.createdAt.toISOString(),
  };
  return record.outcome === null ? { ...run, status: "running" } : { ...run, ...record.outcome };
}

const codemodeFragmentDefinition = defineFragment("codemode")
  .extend(withDatabase(codemodeSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      startRun: function (activationKind: CodemodeActivationKind) {
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
            return uow.create("run", { activationKind, outcome: null }).valueOf();
          })
          .build();
      },

      finishRun: function (runId: string, completion: CodemodeRunCompletion) {
        const outcome: CodemodeRunOutcome =
          completion.status === "completed"
            ? { status: "completed", logs: completion.logs }
            : { status: "failed", error: completion.error, logs: completion.logs };
        return this.serviceTx(codemodeSchema)
          .mutate(({ uow }) => {
            uow.update("run", runId, (b) => b.set({ outcome }));
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
export function createCodemodeFragment(options: FragnoPublicConfigWithDatabase) {
  return instantiate(codemodeFragmentDefinition)
    .withConfig({})
    .withRoutes([])
    .withOptions(options)
    .build();
}

export type CodemodeFragment = ReturnType<typeof createCodemodeFragment>;
