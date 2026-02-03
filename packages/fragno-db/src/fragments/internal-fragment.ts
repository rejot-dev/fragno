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
import { coerceVersionstampBytes, hexToVersionstamp, versionstampToHex } from "../outbox/outbox";
import { dbNow } from "../query/db-now";

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
    })
    .addTable("fragno_db_outbox", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("versionstamp", column("binary"))
        .addColumn("uowId", column("string"))
        .addColumn("payload", column("json"))
        .addColumn("refMap", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_outbox_versionstamp", ["versionstamp"], { unique: true })
        .createIndex("idx_outbox_uow", ["uowId"]);
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
  .providesBaseService(({ deps }) => ({
    getDbNow: async () => {
      if (deps.db.now) {
        return deps.db.now();
      }
      return new Date();
    },
  }))
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
        const now = dbNow();
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
        const now = dbNow();
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
      getNextProcessingStaleAt(namespace: string, timeoutMinutes: number, now?: Date) {
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

            const baseNow = now ?? new Date();
            const nowMs = baseNow.getTime();
            const timeoutMs = timeoutMinutes * 60_000;
            let earliestStaleAt: Date | null = null;

            for (const event of events) {
              if (!event.lastAttemptAt) {
                return baseNow;
              }

              const staleAtMs = event.lastAttemptAt.getTime() + timeoutMs;
              if (staleAtMs <= nowMs) {
                return baseNow;
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
      getNextHookWakeAt(namespace: string, timeoutMinutes?: number | false, now?: Date) {
        const baseNow = now ?? new Date();
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

            const nowMs = baseNow.getTime();
            let earliestPendingAt: Date | null = null;
            let earliestStaleAt: Date | null = null;

            for (const event of events) {
              if (event.status === "pending") {
                const nextRetryAt = event.nextRetryAt;
                if (!nextRetryAt || nextRetryAt.getTime() <= nowMs) {
                  return baseNow;
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
                return baseNow;
              }

              const staleAtMs = lastAttemptAt.getTime() + timeoutMs;
              if (staleAtMs <= nowMs) {
                return baseNow;
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
              b.set({ status: "completed", lastAttemptAt: dbNow() }).check(),
            ),
          )
          .build();
      },

      /**
       * Mark a hook event as failed and schedule next retry.
       */
      markHookFailed(
        eventId: FragnoId,
        error: string,
        attempts: number,
        retryPolicy: RetryPolicy,
        now?: Date,
      ) {
        const newAttempts = attempts + 1;
        const shouldRetry = retryPolicy.shouldRetry(newAttempts - 1);

        return this.serviceTx(internalSchema)
          .mutate(({ uow }) => {
            if (shouldRetry) {
              const delayMs = retryPolicy.getDelayMs(newAttempts - 1);
              const baseNow = now ?? new Date();
              const nextRetryAt = new Date(baseNow.getTime() + delayMs);
              uow.update("fragno_hooks", eventId, (b) =>
                b
                  .set({
                    status: "pending",
                    attempts: newAttempts,
                    lastAttemptAt: dbNow(),
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
                    lastAttemptAt: dbNow(),
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
              b.set({ status: "processing", lastAttemptAt: dbNow() }).check(),
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
  .providesService("outboxService", ({ defineService }) => {
    return defineService({
      /**
       * List outbox entries ordered by versionstamp (ascending).
       */
      list({ afterVersionstamp, limit }: { afterVersionstamp?: string; limit?: number } = {}) {
        const afterBytes = afterVersionstamp ? hexToVersionstamp(afterVersionstamp) : undefined;

        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_db_outbox", (b) => {
              let builder = afterBytes
                ? b.whereIndex("idx_outbox_versionstamp", (eb) =>
                    eb("versionstamp", ">", afterBytes),
                  )
                : b.whereIndex("idx_outbox_versionstamp");

              builder = builder.orderByIndex("idx_outbox_versionstamp", "asc");
              if (limit !== undefined) {
                builder = builder.pageSize(limit);
              }
              return builder;
            }),
          )
          .transformRetrieve(([entries]) =>
            entries.map((entry) => ({
              id: entry.id,
              versionstamp: versionstampToHex(coerceVersionstampBytes(entry.versionstamp)),
              uowId: entry.uowId,
              payload: entry.payload,
              refMap: entry.refMap ?? undefined,
              createdAt: entry.createdAt,
            })),
          )
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
