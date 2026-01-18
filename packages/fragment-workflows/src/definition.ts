import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { Cursor } from "@fragno-dev/db";
import { workflowsSchema } from "./schema";
import type { InstanceStatus } from "./workflow";

const DEFAULT_PAGE_SIZE = 25;

const INSTANCE_STATUSES = new Set<InstanceStatus["status"]>([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
]);

const TERMINAL_STATUSES = new Set<InstanceStatus["status"]>(["complete", "terminated", "errored"]);

const PAUSED_STATUSES = new Set<InstanceStatus["status"]>(["paused", "waitingForPause"]);

type WorkflowInstanceRecord = {
  status: string;
  output: unknown | null;
  errorName: string | null;
  errorMessage: string | null;
};

type ListInstancesParams = {
  workflowName: string;
  status?: InstanceStatus["status"];
  pageSize?: number;
  cursor?: Cursor;
  order?: "asc" | "desc";
};

type InstanceDetails = { id: string; details: InstanceStatus };

function generateInstanceId() {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `inst_${timePart}_${randomPart}`;
}

function buildInstanceStatus(instance: WorkflowInstanceRecord): InstanceStatus {
  const status = INSTANCE_STATUSES.has(instance.status as InstanceStatus["status"])
    ? (instance.status as InstanceStatus["status"])
    : "unknown";

  const error =
    instance.errorName || instance.errorMessage
      ? {
          name: instance.errorName ?? "Error",
          message: instance.errorMessage ?? "",
        }
      : undefined;

  return {
    status,
    error,
    output: instance.output ?? undefined,
  };
}

function isTerminalStatus(status: InstanceStatus["status"]) {
  return TERMINAL_STATUSES.has(status);
}

function isPausedStatus(status: InstanceStatus["status"]) {
  return PAUSED_STATUSES.has(status);
}

export const workflowsFragmentDefinition = defineFragment("workflows")
  .extend(withDatabase(workflowsSchema))
  .providesBaseService(({ defineService }) => {
    return defineService({
      createInstance: function (workflowName: string, options?: { id?: string; params?: unknown }) {
        const instanceId = options?.id ?? generateInstanceId();
        const params = options?.params ?? {};
        const now = new Date();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing] }) => {
            if (existing) {
              throw new Error("INSTANCE_ID_ALREADY_EXISTS");
            }

            uow.create("workflow_instance", {
              workflowName,
              instanceId,
              status: "queued",
              params,
              pauseRequested: false,
              retentionUntil: null,
              runNumber: 0,
              startedAt: null,
              completedAt: null,
              output: null,
              errorName: null,
              errorMessage: null,
            });

            uow.create("workflow_task", {
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

            return {
              id: instanceId,
              details: buildInstanceStatus({
                status: "queued",
                output: null,
                errorName: null,
                errorMessage: null,
              }),
            };
          })
          .build();
      },
      createBatch: function (workflowName: string, instances: { id: string; params?: unknown }[]) {
        if (instances.length === 0) {
          return Promise.resolve([]);
        }

        const now = new Date();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.find("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(
                  eb("workflowName", "=", workflowName),
                  eb(
                    "instanceId",
                    "in",
                    instances.map((instance) => instance.id),
                  ),
                ),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [existingInstances] }) => {
            const existingIds = new Set(existingInstances.map((record) => record.instanceId));

            const created: InstanceDetails[] = [];

            for (const instance of instances) {
              if (existingIds.has(instance.id)) {
                continue;
              }

              uow.create("workflow_instance", {
                workflowName,
                instanceId: instance.id,
                status: "queued",
                params: instance.params ?? {},
                pauseRequested: false,
                retentionUntil: null,
                runNumber: 0,
                startedAt: null,
                completedAt: null,
                output: null,
                errorName: null,
                errorMessage: null,
              });

              uow.create("workflow_task", {
                workflowName,
                instanceId: instance.id,
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

              created.push({
                id: instance.id,
                details: buildInstanceStatus({
                  status: "queued",
                  output: null,
                  errorName: null,
                  errorMessage: null,
                }),
              });
            }

            return created;
          })
          .build();
      },
      getInstanceStatus: function (workflowName: string, instanceId: string) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .transformRetrieve(([instance]) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }
            return buildInstanceStatus(instance);
          })
          .build();
      },
      listInstances: function ({
        workflowName,
        status,
        pageSize = DEFAULT_PAGE_SIZE,
        cursor,
        order = "desc",
      }: ListInstancesParams) {
        const effectivePageSize = cursor?.pageSize ?? pageSize;
        const effectiveOrder = cursor?.orderDirection ?? order;

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("workflow_instance", (b) => {
              if (status) {
                const query = b
                  .whereIndex("idx_workflow_instance_status_updatedAt", (eb) =>
                    eb.and(eb("workflowName", "=", workflowName), eb("status", "=", status)),
                  )
                  .orderByIndex("idx_workflow_instance_status_updatedAt", effectiveOrder)
                  .pageSize(effectivePageSize);

                return cursor ? query.after(cursor) : query;
              }

              const query = b
                .whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb("workflowName", "=", workflowName),
                )
                .orderByIndex("idx_workflow_instance_workflowName_instanceId", effectiveOrder)
                .pageSize(effectivePageSize);

              return cursor ? query.after(cursor) : query;
            }),
          )
          .transformRetrieve(([instances]) => {
            return {
              instances: instances.items.map((instance) => ({
                id: instance.instanceId,
                details: buildInstanceStatus(instance),
              })),
              cursor: instances.cursor,
              hasNextPage: instances.hasNextPage,
            };
          })
          .build();
      },
      pauseInstance: function (workflowName: string, instanceId: string) {
        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [instance] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (isTerminalStatus(currentStatus)) {
              throw new Error("INSTANCE_TERMINAL");
            }

            if (currentStatus === "running") {
              uow.update("workflow_instance", instance.id, (b) =>
                b
                  .set({
                    status: "waitingForPause",
                    pauseRequested: true,
                    updatedAt: new Date(),
                  })
                  .check(),
              );

              return buildInstanceStatus({
                status: "waitingForPause",
                output: instance.output,
                errorName: instance.errorName,
                errorMessage: instance.errorMessage,
              });
            }

            if (currentStatus === "queued" || currentStatus === "waiting") {
              uow.update("workflow_instance", instance.id, (b) =>
                b
                  .set({
                    status: "paused",
                    pauseRequested: false,
                    updatedAt: new Date(),
                  })
                  .check(),
              );

              return buildInstanceStatus({
                status: "paused",
                output: instance.output,
                errorName: instance.errorName,
                errorMessage: instance.errorMessage,
              });
            }

            return buildInstanceStatus(instance);
          })
          .build();
      },
      resumeInstance: function (workflowName: string, instanceId: string) {
        const now = new Date();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_task", (b) =>
                b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, tasks] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (currentStatus !== "paused") {
              return buildInstanceStatus(instance);
            }

            const task = tasks.find((candidate) => candidate.runNumber === instance.runNumber);

            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "queued",
                  pauseRequested: false,
                  updatedAt: now,
                })
                .check(),
            );

            if (task) {
              uow.update("workflow_task", task.id, (b) =>
                b
                  .set({
                    kind: "resume",
                    runAt: now,
                    status: "pending",
                    attempts: 0,
                    lastError: null,
                    lockedUntil: null,
                    lockOwner: null,
                    updatedAt: now,
                  })
                  .check(),
              );
            } else {
              uow.create("workflow_task", {
                workflowName,
                instanceId,
                runNumber: instance.runNumber,
                kind: "resume",
                runAt: now,
                status: "pending",
                attempts: 0,
                maxAttempts: 1,
                lastError: null,
                lockedUntil: null,
                lockOwner: null,
              });
            }

            return buildInstanceStatus({
              status: "queued",
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      terminateInstance: function (workflowName: string, instanceId: string) {
        const now = new Date();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [instance] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (isTerminalStatus(currentStatus)) {
              throw new Error("INSTANCE_TERMINAL");
            }

            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "terminated",
                  completedAt: now,
                  updatedAt: now,
                  pauseRequested: false,
                })
                .check(),
            );

            return buildInstanceStatus({
              status: "terminated",
              output: instance.output,
              errorName: instance.errorName,
              errorMessage: instance.errorMessage,
            });
          })
          .build();
      },
      restartInstance: function (workflowName: string, instanceId: string) {
        const now = new Date();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow.findFirst("workflow_instance", (b) =>
              b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
              ),
            ),
          )
          .mutate(({ uow, retrieveResult: [instance] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const nextRun = instance.runNumber + 1;

            uow.update("workflow_instance", instance.id, (b) =>
              b
                .set({
                  status: "queued",
                  pauseRequested: false,
                  runNumber: nextRun,
                  startedAt: null,
                  completedAt: null,
                  output: null,
                  errorName: null,
                  errorMessage: null,
                  updatedAt: now,
                })
                .check(),
            );

            uow.create("workflow_task", {
              workflowName,
              instanceId,
              runNumber: nextRun,
              kind: "run",
              runAt: now,
              status: "pending",
              attempts: 0,
              maxAttempts: 1,
              lastError: null,
              lockedUntil: null,
              lockOwner: null,
            });

            return buildInstanceStatus({
              status: "queued",
              output: null,
              errorName: null,
              errorMessage: null,
            });
          })
          .build();
      },
      sendEvent: function (
        workflowName: string,
        instanceId: string,
        options: { type: string; payload?: unknown },
      ) {
        const now = new Date();

        return this.serviceTx(workflowsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("workflow_instance", (b) =>
                b.whereIndex("idx_workflow_instance_workflowName_instanceId", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              )
              .find("workflow_step", (b) =>
                b.whereIndex("idx_workflow_step_status_wakeAt", (eb) =>
                  eb.and(
                    eb("workflowName", "=", workflowName),
                    eb("instanceId", "=", instanceId),
                    eb("status", "=", "waiting"),
                  ),
                ),
              )
              .find("workflow_task", (b) =>
                b.whereIndex("idx_workflow_task_workflowName_instanceId_runNumber", (eb) =>
                  eb.and(eb("workflowName", "=", workflowName), eb("instanceId", "=", instanceId)),
                ),
              ),
          )
          .mutate(({ uow, retrieveResult: [instance, steps, tasks] }) => {
            if (!instance) {
              throw new Error("INSTANCE_NOT_FOUND");
            }

            const currentStatus = buildInstanceStatus(instance).status;
            if (isTerminalStatus(currentStatus)) {
              throw new Error("INSTANCE_TERMINAL");
            }

            uow.create("workflow_event", {
              workflowName,
              instanceId,
              runNumber: instance.runNumber,
              type: options.type,
              payload: options.payload ?? null,
              deliveredAt: null,
              consumedByStepKey: null,
            });

            const currentRunSteps = steps.filter((step) => step.runNumber === instance.runNumber);
            const currentTask = tasks.find(
              (candidate) => candidate.runNumber === instance.runNumber,
            );
            const shouldWake =
              currentStatus === "waiting" &&
              !isPausedStatus(currentStatus) &&
              currentRunSteps.some((step) => step.waitEventType === options.type);

            if (shouldWake) {
              if (currentTask) {
                uow.update("workflow_task", currentTask.id, (b) =>
                  b
                    .set({
                      kind: "wake",
                      runAt: now,
                      status: "pending",
                      attempts: 0,
                      lastError: null,
                      lockedUntil: null,
                      lockOwner: null,
                      updatedAt: now,
                    })
                    .check(),
                );
              } else {
                uow.create("workflow_task", {
                  workflowName,
                  instanceId,
                  runNumber: instance.runNumber,
                  kind: "wake",
                  runAt: now,
                  status: "pending",
                  attempts: 0,
                  maxAttempts: 1,
                  lastError: null,
                  lockedUntil: null,
                  lockOwner: null,
                });
              }
            }

            return buildInstanceStatus(instance);
          })
          .build();
      },
    });
  })
  .build();
