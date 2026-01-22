import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "@fragno-dev/db";
import { FragnoId } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface, TableToColumnValues } from "@fragno-dev/db/query";
import type { UnitOfWorkConfig } from "@fragno-dev/db/unit-of-work";
import { createRawUowTransaction, defaultStateHasher, runModelChecker } from "@fragno-dev/test";
import { workflowsSchema } from "./schema";

type WorkflowTaskRecord = TableToColumnValues<(typeof workflowsSchema)["tables"]["workflow_task"]>;

describe("Workflows model checker", () => {
  it("does not allow double-claiming the same task", async () => {
    const createContext = async () => {
      const adapter = new InMemoryAdapter({ idSeed: "workflows-model-checker" });
      const queryEngine = adapter.createQueryEngine(workflowsSchema, "workflows");
      return {
        ctx: {
          queryEngine,
          createUnitOfWork: queryEngine.createUnitOfWork,
        },
        cleanup: async () => {
          await adapter.close();
        },
      };
    };

    const workflowName = "demo-workflow";
    const instanceId = "instance-1";
    const now = new Date("2025-01-01T00:00:00.000Z");

    const stateHasher = async (ctx: {
      schema: typeof workflowsSchema;
      queryEngine: SimpleQueryInterface<typeof workflowsSchema, UnitOfWorkConfig>;
    }) => {
      const claims = await ctx.queryEngine.find("workflow_log", (b) =>
        b.whereIndex("idx_workflow_log_category_createdAt", (eb) =>
          eb.and(
            eb("workflowName", "=", workflowName),
            eb("instanceId", "=", instanceId),
            eb("runNumber", "=", 0),
            eb("category", "=", "claim"),
          ),
        ),
      );

      if (claims.length > 1) {
        throw new Error("Task claimed more than once");
      }

      return defaultStateHasher(ctx);
    };

    const buildClaimTx = (runnerId: string) =>
      createRawUowTransaction<
        WorkflowTaskRecord | null,
        void,
        typeof workflowsSchema,
        UnitOfWorkConfig
      >({
        name: `claim-${runnerId}`,
        retrieve: async (uow) => {
          const typed = uow
            .forSchema(workflowsSchema)
            .findFirst("workflow_task", (b) =>
              b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
                eb.and(
                  eb("workflowName", "=", workflowName),
                  eb("instanceId", "=", instanceId),
                  eb("runNumber", "=", 0),
                ),
              ),
            );

          await uow.executeRetrieve();
          const [task] = await typed.retrievalPhase;
          return task ?? null;
        },
        mutate: async (uow, txCtx) => {
          const task = txCtx.retrieveResult;
          if (!task || task.status !== "pending") {
            return;
          }

          uow.forSchema(workflowsSchema).update("workflow_task", task.id, (b) => {
            const update = b.set({
              status: "processing",
              lockOwner: runnerId,
              lockedUntil: new Date(now.getTime() + 60_000),
              updatedAt: now,
            });
            if (task.id instanceof FragnoId) {
              update.check();
            }
            return update;
          });

          uow.forSchema(workflowsSchema).create("workflow_log", {
            workflowName,
            instanceId,
            runNumber: 0,
            stepKey: null,
            attempt: null,
            level: "info",
            category: "claim",
            message: `claimed:${runnerId}`,
            data: null,
            isReplay: false,
          });

          const { success } = await uow.executeMutations();
          if (!success) {
            return;
          }
        },
      });

    await expect(
      runModelChecker({
        schema: workflowsSchema,
        mode: "exhaustive",
        history: false,
        stateHasher,
        createContext,
        setup: async (ctx) => {
          await ctx.queryEngine.create("workflow_instance", {
            workflowName,
            instanceId,
            status: "queued",
            params: {},
            pauseRequested: false,
            retentionUntil: null,
            runNumber: 0,
            startedAt: null,
            completedAt: null,
            output: null,
            errorName: null,
            errorMessage: null,
          });

          await ctx.queryEngine.create("workflow_task", {
            workflowName,
            instanceId,
            runNumber: 0,
            kind: "run",
            runAt: now,
            status: "pending",
            attempts: 0,
            maxAttempts: 1,
            lastError: null,
            lockedUntil: null,
            lockOwner: null,
          });
        },
        buildTransactions: () => [buildClaimTx("runner-a"), buildClaimTx("runner-b")],
      }),
    ).resolves.toBeDefined();
  });
});
