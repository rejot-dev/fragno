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
import type { RetryPolicy } from "../query/unit-of-work/retry-policy";
import { dbNow, type DbNow } from "../query/db-now";
import {
  internalSchema,
  INTERNAL_MIGRATION_VERSION_KEY,
  SETTINGS_NAMESPACE,
  SETTINGS_TABLE_NAME,
} from "./internal-fragment.schema";

type AdapterRegistry = {
  listSchemas: () => Array<{
    name: string;
    namespace: string | null;
    version: number;
    tables: string[];
  }>;
  listOutboxFragments: () => Array<{ name: string; mountRoute: string }>;
  isOutboxEnabled: () => boolean;
  resolveSyncCommand: (
    fragmentName: string,
    schemaName: string,
    commandName: string,
  ) => { command: unknown; namespace: string | null } | undefined;
};

export class SchemaRegistryCollisionError extends Error {
  readonly code = "SCHEMA_REGISTRY_COLLISION" as const;
  readonly namespaceKey: string;
  readonly existing: { name: string; namespace: string | null };
  readonly attempted: { name: string; namespace: string | null };

  constructor({
    namespaceKey,
    existing,
    attempted,
  }: {
    namespaceKey: string;
    existing: { name: string; namespace: string | null };
    attempted: { name: string; namespace: string | null };
  }) {
    super(
      `Schema namespace "${namespaceKey}" is already owned by "${existing.name}" (${existing.namespace ?? "null"}).`,
    );
    this.name = "SchemaRegistryCollisionError";
    this.namespaceKey = namespaceKey;
    this.existing = existing;
    this.attempted = attempted;
  }
}

export type InternalFragmentConfig = {
  registry?: AdapterRegistry;
};

export { internalSchema, INTERNAL_MIGRATION_VERSION_KEY, SETTINGS_NAMESPACE, SETTINGS_TABLE_NAME };

const INTERNAL_SCHEMA_MIN_VERSION = 4;
if (internalSchema.version < INTERNAL_SCHEMA_MIN_VERSION) {
  // Keep the internal schema version monotonic after removing fragno_db_schemas.
  internalSchema.version = INTERNAL_SCHEMA_MIN_VERSION;
}

// This uses DatabaseFragmentDefinitionBuilder directly
// to avoid circular dependency (it doesn't need to link to itself)
export const internalFragmentDef = new DatabaseFragmentDefinitionBuilder(
  new FragmentDefinitionBuilder<
    InternalFragmentConfig,
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
       * Set a setting value only if it does not already exist.
       */
      setIfMissing(namespace: string, key: string, value: string) {
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
              return;
            }
            uow.create(SETTINGS_TABLE_NAME, {
              key: fullKey,
              value,
            });
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
              status: event.status,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              lastAttemptAt: event.lastAttemptAt,
              nextRetryAt: event.nextRetryAt,
              createdAt: event.createdAt,
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
              status: event.status,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              lastAttemptAt: event.lastAttemptAt,
              nextRetryAt: event.nextRetryAt,
              createdAt: event.createdAt,
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
              status: "processing" as const,
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
       * Claim stale processing hook events for processing.
       * Returns ready events and marks them as processing in the same transaction.
       */
      claimStuckProcessingHookEvents(namespace: string, staleBefore: DbNow) {
        const now = dbNow();

        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_hooks", (b) =>
              b.whereIndex("idx_namespace_status_last_attempt", (eb) =>
                eb.and(
                  eb("namespace", "=", namespace),
                  eb("status", "=", "processing"),
                  eb.or(eb.isNull("lastAttemptAt"), eb("lastAttemptAt", "<=", staleBefore)),
                ),
              ),
            ),
          )
          .transformRetrieve(([events]) => {
            return events.map((event) => ({
              id: event.id,
              hookName: event.hookName,
              payload: event.payload as unknown,
              status: event.status,
              attempts: event.attempts,
              maxAttempts: event.maxAttempts,
              idempotencyKey: event.nonce,
              lastAttemptAt: event.lastAttemptAt,
              nextRetryAt: event.nextRetryAt,
              createdAt: event.createdAt,
            }));
          })
          .mutate(({ uow, retrieveResult }) => {
            if (retrieveResult.length === 0) {
              return;
            }

            for (const event of retrieveResult) {
              uow.update("fragno_hooks", event.id, (b) =>
                b.set({ status: "processing", lastAttemptAt: now, nextRetryAt: null }).check(),
              );
            }
          })
          .transform(({ retrieveResult }) => {
            return {
              events: retrieveResult.map((event) => ({
                ...event,
                id: new FragnoId({
                  externalId: event.id.externalId,
                  internalId: event.id.internalId,
                  version: event.id.version + 1,
                }),
              })),
              stuckEvents: retrieveResult.map((event) => ({
                id: event.id,
                hookName: event.hookName,
                attempts: event.attempts,
                maxAttempts: event.maxAttempts,
                lastAttemptAt: event.lastAttemptAt,
                nextRetryAt: event.nextRetryAt,
              })),
            };
          })
          .build();
      },

      /**
       * Get the earliest pending hook wake time for a namespace.
       * Optionally considers processing hooks becoming stale when timeoutMinutes is provided.
       */
      getNextHookWakeAt(namespace: string, timeoutMinutes?: number | false) {
        const timeoutMinutesValue =
          typeof timeoutMinutes === "number" && timeoutMinutes > 0 ? timeoutMinutes : 0;
        const includeProcessing = timeoutMinutesValue > 0;
        const now = dbNow();
        const timeoutMs = timeoutMinutesValue * 60_000;
        // Sentinel to keep query shape stable when processing checks are disabled.
        const processingStatus = includeProcessing ? "processing" : "__disabled__";
        const staleBefore = now.plus({ minutes: -timeoutMinutesValue });

        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow
              .forSchema(internalSchema)
              .find("fragno_hooks", (b) =>
                b
                  .whereIndex("idx_namespace_status_retry", (eb) =>
                    eb.and(
                      eb("namespace", "=", namespace),
                      eb("status", "=", "pending"),
                      eb.or(eb.isNull("nextRetryAt"), eb("nextRetryAt", "<=", now)),
                    ),
                  )
                  .pageSize(1),
              )
              .find("fragno_hooks", (b) =>
                b
                  .whereIndex("idx_namespace_status_retry", (eb) =>
                    eb.and(
                      eb("namespace", "=", namespace),
                      eb("status", "=", "pending"),
                      eb.isNotNull("nextRetryAt"),
                      eb("nextRetryAt", ">", now),
                    ),
                  )
                  .orderByIndex("idx_namespace_status_retry", "asc")
                  .pageSize(1)
                  .select(["nextRetryAt"]),
              )
              .find("fragno_hooks", (b) =>
                b
                  .whereIndex("idx_namespace_status_last_attempt", (eb) =>
                    eb.and(
                      eb("namespace", "=", namespace),
                      eb("status", "=", processingStatus),
                      eb.or(eb.isNull("lastAttemptAt"), eb("lastAttemptAt", "<=", staleBefore)),
                    ),
                  )
                  .pageSize(1),
              )
              .find("fragno_hooks", (b) =>
                b
                  .whereIndex("idx_namespace_status_last_attempt", (eb) =>
                    eb.and(
                      eb("namespace", "=", namespace),
                      eb("status", "=", processingStatus),
                      eb.isNotNull("lastAttemptAt"),
                      eb("lastAttemptAt", ">", staleBefore),
                    ),
                  )
                  .orderByIndex("idx_namespace_status_last_attempt", "asc")
                  .pageSize(1)
                  .select(["lastAttemptAt"]),
              ),
          )
          .transformRetrieve(
            ([pendingImmediate, pendingNext, processingImmediate, processingNext]) => {
              const hasProcessingImmediate = includeProcessing && processingImmediate.length > 0;

              if (pendingImmediate.length > 0 || hasProcessingImmediate) {
                return new Date();
              }

              const pendingNextAt = pendingNext[0]?.nextRetryAt ?? null;
              let processingNextAt: Date | null = null;

              if (includeProcessing) {
                const lastAttemptAt = processingNext[0]?.lastAttemptAt;
                if (lastAttemptAt) {
                  processingNextAt = new Date(lastAttemptAt.getTime() + timeoutMs);
                }
              }

              if (!pendingNextAt) {
                return processingNextAt ?? null;
              }
              if (!processingNextAt) {
                return pendingNextAt;
              }
              return pendingNextAt <= processingNextAt ? pendingNextAt : processingNextAt;
            },
          )
          .build();
      },

      /**
       * Mark a hook event as failed and schedule next retry.
       */
      markHookFailed(eventId: FragnoId, error: string, attempts: number, retryPolicy: RetryPolicy) {
        const newAttempts = attempts + 1;
        const shouldRetry = retryPolicy.shouldRetry(newAttempts - 1);
        const now = dbNow();

        return this.serviceTx(internalSchema)
          .mutate(({ uow }) => {
            if (shouldRetry) {
              const delayMs = retryPolicy.getDelayMs(newAttempts - 1);
              const nextRetryAt = now.plus({ ms: delayMs });
              uow.update("fragno_hooks", eventId, (b) =>
                b
                  .set({
                    status: "pending",
                    attempts: newAttempts,
                    lastAttemptAt: now,
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
                    lastAttemptAt: now,
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
        const afterValue = afterVersionstamp?.toLowerCase();

        return this.serviceTx(internalSchema)
          .retrieve((uow) =>
            uow.find("fragno_db_outbox", (b) => {
              let builder = afterValue
                ? b.whereIndex("idx_outbox_versionstamp", (eb) =>
                    eb("versionstamp", ">", afterValue),
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
              versionstamp: entry.versionstamp,
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

const SCHEMA_VERSION_KEY = "schema_version";

async function readNumericSetting(
  fragment: InternalFragmentInstance,
  namespace: string,
  key: string,
): Promise<number | undefined> {
  const setting = await fragment.inContext(async function () {
    return await this.handlerTx()
      .withServiceCalls(() => [fragment.services.settingsService.get(namespace, key)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute();
  });

  if (!setting) {
    return undefined;
  }

  const parsed = parseInt(setting.value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export async function getSchemaVersionFromDatabase(
  fragment: InternalFragmentInstance,
  namespace: string,
): Promise<number> {
  try {
    const primary = await readNumericSetting(fragment, namespace, SCHEMA_VERSION_KEY);
    if (primary !== undefined) {
      return primary;
    }

    // Back-compat: some installs stored internal schema version under a different namespace.
    // Check the alternate key (empty string ↔ schema name) so we find the version either way.
    const legacyNamespace =
      namespace === "" ? internalSchema.name : namespace === internalSchema.name ? "" : null;
    if (legacyNamespace !== null) {
      const legacy = await readNumericSetting(fragment, legacyNamespace, SCHEMA_VERSION_KEY);
      if (legacy !== undefined) {
        return legacy;
      }
    }

    return 0;
  } catch {
    return 0;
  }
}

export async function getInternalMigrationVersionFromDatabase(
  fragment: InternalFragmentInstance,
  namespace: string,
): Promise<number> {
  try {
    const value = await readNumericSetting(fragment, namespace, INTERNAL_MIGRATION_VERSION_KEY);
    return value ?? 0;
  } catch {
    return 0;
  }
}
