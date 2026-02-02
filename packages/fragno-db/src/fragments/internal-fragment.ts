import { FragmentDefinitionBuilder } from "@fragno-dev/core";
import type { InstantiatedFragmentFromDefinition } from "@fragno-dev/core";
import {
  DatabaseFragmentDefinitionBuilder,
  type DatabaseHandlerContext,
  type DatabaseRequestStorage,
  type DatabaseServiceContext,
  type FragnoPublicConfigWithDatabase,
  type ImplicitDatabaseDependencies,
} from "../db-fragment-definition-builder";
import { FragnoId } from "../schema/create";
import { schema, idColumn, column } from "../schema/create";
import type { RetryPolicy } from "../query/unit-of-work/retry-policy";

// Constants for Fragno's internal settings table
export const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;
// FIXME: In some places we simply use empty string "" as namespace, which is not correct.
export const SETTINGS_NAMESPACE = "fragno-db-settings" as const;

export const internalSchema = schema((s) => {
  return s
    .addTable(SETTINGS_TABLE_NAME, (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("key", column("string"))
        .addColumn("value", column("string"))
        .createIndex("unique_key", ["key"], { unique: true });
    })
    .addTable("fragno_hooks", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("namespace", column("string"))
        .addColumn("hookName", column("string"))
        .addColumn("payload", column("json"))
        .addColumn("status", column("string")) // "pending" | "processing" | "completed" | "failed"
        .addColumn("attempts", column("integer").defaultTo(0))
        .addColumn("maxAttempts", column("integer").defaultTo(5))
        .addColumn("lastAttemptAt", column("timestamp").nullable())
        .addColumn("nextRetryAt", column("timestamp").nullable())
        .addColumn("error", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("nonce", column("string"))
        .createIndex("idx_namespace_status_retry", ["namespace", "status", "nextRetryAt"])
        .createIndex("idx_nonce", ["nonce"]);
    });
});

// This uses DatabaseFragmentDefinitionBuilder directly
// to avoid circular dependency (it doesn't need to link to itself)
export const internalFragmentDef = new DatabaseFragmentDefinitionBuilder(
  new FragmentDefinitionBuilder<
    {},
    FragnoPublicConfigWithDatabase,
    ImplicitDatabaseDependencies<typeof internalSchema>,
    {},
    {},
    {},
    {},
    DatabaseServiceContext<{}>,
    DatabaseHandlerContext,
    DatabaseRequestStorage
  >("$fragno-internal-fragment"),
  internalSchema,
  "", // intentionally blank namespace so there is no prefix
)
  .providesService("settingsService", ({ defineService }) => {
    return defineService({
      /**
       * Get a setting by namespace and key.
       */
      get(namespace: string, key: string) {
        const fullKey = `${namespace}.${key}`;
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.findFirst(SETTINGS_TABLE_NAME, (b) =>
              b.whereIndex("unique_key", (eb) => eb("key", "=", fullKey)),
            ),
          )
          .transformRetrieve(
            ([result]): { id: FragnoId; key: string; value: string } | undefined =>
              result ?? undefined,
          )
          .build();
      },

      /**
       * Set a setting value by namespace and key.
       */
      set(namespace: string, key: string, value: string) {
        const fullKey = `${namespace}.${key}`;
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.findFirst(SETTINGS_TABLE_NAME, (b) =>
              b.whereIndex("unique_key", (eb) => eb("key", "=", fullKey)),
            ),
          )
          .transformRetrieve(([result]) => result)
          .mutate(({ uow, retrieveResult }) => {
            if (retrieveResult) {
              uow.update(SETTINGS_TABLE_NAME, retrieveResult.id, (b) => b.set({ value }).check());
            } else {
              uow.create(SETTINGS_TABLE_NAME, {
                key: fullKey,
                value,
              });
            }
          })
          .build();
      },

      /**
       * Delete a setting by ID.
       */
      delete(id: FragnoId) {
        return this.serviceTx(internalSchema)
          .mutate(({ uow }) => uow.delete(SETTINGS_TABLE_NAME, id))
          .build();
      },
    });
  })
  .providesService("hookService", ({ defineService }) => {
    return defineService({
      /**
       * Get pending hook events for processing.
       * Returns all pending events for the given namespace that are ready to be processed.
       */
      getPendingHookEvents(namespace: string) {
        const now = new Date();
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_hooks", (b) =>
              b.whereIndex("idx_namespace_status_retry", (eb) =>
                eb.and(
                  eb("namespace", "=", namespace),
                  eb("status", "=", "pending"),
                  eb.or(eb.isNull("nextRetryAt"), eb("nextRetryAt", "<=", now)),
                ),
              ),
            ),
          )
          .transformRetrieve(([events]) => {
            return events.map((event) => ({
              id: event.id,
              hookName: event.hookName,
              payload: event.payload as unknown,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              idempotencyKey: event.nonce,
            }));
          })
          .build();
      },

      /**
       * Claim pending hook events for processing.
       * Returns ready events and marks them as processing in the same transaction.
       */
      claimPendingHookEvents(namespace: string) {
        const now = new Date();
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_hooks", (b) =>
              b.whereIndex("idx_namespace_status_retry", (eb) =>
                eb.and(
                  eb("namespace", "=", namespace),
                  eb("status", "=", "pending"),
                  eb.or(eb.isNull("nextRetryAt"), eb("nextRetryAt", "<=", now)),
                ),
              ),
            ),
          )
          .transformRetrieve(([events]) => {
            return events.map((event) => ({
              id: event.id,
              hookName: event.hookName,
              payload: event.payload,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              idempotencyKey: event.nonce,
            }));
          })
          .mutate(({ uow, retrieveResult }) => {
            if (retrieveResult.length === 0) {
              return;
            }
            for (const event of retrieveResult) {
              uow.update("fragno_hooks", event.id, (b) =>
                b.set({ status: "processing", lastAttemptAt: now }).check(),
              );
            }
          })
          .transform(({ retrieveResult }) =>
            retrieveResult.map((event) => ({
              ...event,
              id: new FragnoId({
                externalId: event.id.externalId,
                internalId: event.id.internalId,
                version: event.id.version + 1,
              }),
            })),
          )
          .build();
      },

      /**
       * Re-queue hook events that have been stuck in processing for too long.
       */
      requeueStuckProcessingHooks(namespace: string, staleBefore: Date) {
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_hooks", (b) =>
              b.whereIndex("idx_namespace_status_retry", (eb) =>
                eb.and(eb("namespace", "=", namespace), eb("status", "=", "processing")),
              ),
            ),
          )
          .transformRetrieve(([events]) => {
            const stuck = events.filter((event) => {
              if (!event.lastAttemptAt) {
                return true;
              }
              return event.lastAttemptAt <= staleBefore;
            });

            return stuck.map((event) => ({
              id: event.id,
              hookName: event.hookName,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              lastAttemptAt: event.lastAttemptAt,
              nextRetryAt: event.nextRetryAt,
            }));
          })
          .mutate(({ uow, retrieveResult }) => {
            for (const event of retrieveResult) {
              uow.update("fragno_hooks", event.id, (b) =>
                b.set({ status: "pending", nextRetryAt: null }).check(),
              );
            }
          })
          .transform(({ retrieveResult }) => retrieveResult)
          .build();
      },

      /**
       * Get the next time a processing hook becomes stale.
       */
      getNextProcessingStaleAt(namespace: string, timeoutMinutes: number) {
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_hooks", (b) =>
              b.whereIndex("idx_namespace_status_retry", (eb) =>
                eb.and(eb("namespace", "=", namespace), eb("status", "=", "processing")),
              ),
            ),
          )
          .transformRetrieve(([events]) => {
            if (events.length === 0) {
              return null;
            }

            const now = Date.now();
            const timeoutMs = timeoutMinutes * 60_000;
            let earliestStaleAt: Date | null = null;

            for (const event of events) {
              if (!event.lastAttemptAt) {
                return new Date();
              }

              const staleAtMs = event.lastAttemptAt.getTime() + timeoutMs;
              if (staleAtMs <= now) {
                return new Date();
              }

              const staleAt = new Date(staleAtMs);
              if (!earliestStaleAt || staleAt < earliestStaleAt) {
                earliestStaleAt = staleAt;
              }
            }

            return earliestStaleAt;
          })
          .build();
      },

      /**
       * Get the earliest pending hook wake time for a namespace.
       * Optionally considers processing hooks becoming stale when timeoutMinutes is provided.
       */
      getNextHookWakeAt(namespace: string, timeoutMinutes?: number | false) {
        const now = new Date();
        const includeProcessing = typeof timeoutMinutes === "number" && timeoutMinutes > 0;
        const timeoutMs = includeProcessing ? timeoutMinutes * 60_000 : 0;

        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_hooks", (b) =>
              b
                .whereIndex("idx_namespace_status_retry", (eb) => {
                  if (includeProcessing) {
                    return eb.and(
                      eb("namespace", "=", namespace),
                      eb.or(eb("status", "=", "pending"), eb("status", "=", "processing")),
                    );
                  }
                  return eb.and(eb("namespace", "=", namespace), eb("status", "=", "pending"));
                })
                .select(["status", "nextRetryAt", "lastAttemptAt"]),
            ),
          )
          .transformRetrieve(([events]) => {
            if (events.length === 0) {
              return null;
            }

            const nowMs = now.getTime();
            let earliestPendingAt: Date | null = null;
            let earliestStaleAt: Date | null = null;

            for (const event of events) {
              if (event.status === "pending") {
                const nextRetryAt = event.nextRetryAt;
                if (!nextRetryAt || nextRetryAt.getTime() <= nowMs) {
                  return now;
                }
                if (!earliestPendingAt || nextRetryAt < earliestPendingAt) {
                  earliestPendingAt = nextRetryAt;
                }
                continue;
              }

              if (!includeProcessing || event.status !== "processing") {
                continue;
              }

              const lastAttemptAt = event.lastAttemptAt;
              if (!lastAttemptAt) {
                return now;
              }

              const staleAtMs = lastAttemptAt.getTime() + timeoutMs;
              if (staleAtMs <= nowMs) {
                return now;
              }

              const staleAt = new Date(staleAtMs);
              if (!earliestStaleAt || staleAt < earliestStaleAt) {
                earliestStaleAt = staleAt;
              }
            }

            if (!earliestPendingAt) {
              return earliestStaleAt ?? null;
            }
            if (!earliestStaleAt) {
              return earliestPendingAt;
            }
            return earliestPendingAt <= earliestStaleAt ? earliestPendingAt : earliestStaleAt;
          })
          .build();
      },

      /**
       * Mark a hook event as completed.
       */
      markHookCompleted(eventId: FragnoId) {
        return this.serviceTx(internalSchema)
          .mutate(({ uow }) =>
            uow.update("fragno_hooks", eventId, (b) =>
              b.set({ status: "completed", lastAttemptAt: new Date() }).check(),
            ),
          )
          .build();
      },

      /**
       * Mark a hook event as failed and schedule next retry.
       */
      markHookFailed(eventId: FragnoId, error: string, attempts: number, retryPolicy: RetryPolicy) {
        const newAttempts = attempts + 1;
        const shouldRetry = retryPolicy.shouldRetry(newAttempts - 1);

        return this.serviceTx(internalSchema)
          .mutate(({ uow }) => {
            if (shouldRetry) {
              const delayMs = retryPolicy.getDelayMs(newAttempts - 1);
              const nextRetryAt = new Date(Date.now() + delayMs);
              uow.update("fragno_hooks", eventId, (b) =>
                b
                  .set({
                    status: "pending",
                    attempts: newAttempts,
                    lastAttemptAt: new Date(),
                    nextRetryAt,
                    error,
                  })
                  .check(),
              );
            } else {
              uow.update("fragno_hooks", eventId, (b) =>
                b
                  .set({
                    status: "failed",
                    attempts: newAttempts,
                    lastAttemptAt: new Date(),
                    error,
                  })
                  .check(),
              );
            }
          })
          .build();
      },

      /**
       * Mark a hook event as processing (to prevent concurrent execution).
       */
      markHookProcessing(eventId: FragnoId) {
        return this.serviceTx(internalSchema)
          .mutate(({ uow }) =>
            uow.update("fragno_hooks", eventId, (b) =>
              b.set({ status: "processing", lastAttemptAt: new Date() }).check(),
            ),
          )
          .build();
      },

      /**
       * Get a hook event by ID (for testing/verification purposes).
       */
      getHookById(eventId: FragnoId) {
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.findFirst("fragno_hooks", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", eventId)),
            ),
          )
          .transformRetrieve(([result]) => result ?? undefined)
          .build();
      },

      /**
       * Get all hook events for a namespace (for testing/verification purposes).
       */
      getHooksByNamespace(namespace: string) {
        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_hooks", (b) =>
              b.whereIndex("idx_namespace_status_retry", (eb) => eb("namespace", "=", namespace)),
            ),
          )
          .transformRetrieve(([events]) => events)
          .build();
      },
    });
  })
  .build();

/**
 * Type representing an instantiated internal fragment.
 * This is the fragment that manages Fragno's internal settings table.
 */
export type InternalFragmentInstance = InstantiatedFragmentFromDefinition<
  typeof internalFragmentDef
>;

export async function getSchemaVersionFromDatabase(
  fragment: InternalFragmentInstance,
  namespace: string,
): Promise<number> {
  try {
    const setting = await fragment.inContext(async function () {
      return await this.handlerTx()
        .withServiceCalls(
          () => [fragment.services.settingsService.get(namespace, "schema_version")] as const,
        )
        .transform(({ serviceResult: [result] }) => result)
        .execute();
    });
    return setting ? parseInt(setting.value, 10) : 0;
  } catch {
    return 0;
  }
}
