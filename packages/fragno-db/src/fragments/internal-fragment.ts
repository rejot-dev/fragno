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
import type { FragnoId } from "../schema/create";
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
      async get(
        namespace: string,
        key: string,
      ): Promise<{ id: FragnoId; key: string; value: string } | undefined> {
        const fullKey = `${namespace}.${key}`;
        const uow = this.uow(internalSchema).find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", fullKey)),
        );
        const [results] = await uow.retrievalPhase;
        return results?.[0];
      },

      async set(namespace: string, key: string, value: string) {
        const fullKey = `${namespace}.${key}`;
        const uow = this.uow(internalSchema);

        // First, find if the key already exists
        const findUow = uow.find(SETTINGS_TABLE_NAME, (b) =>
          b.whereIndex("unique_key", (eb) => eb("key", "=", fullKey)),
        );
        const [existing] = await findUow.retrievalPhase;

        if (existing?.[0]) {
          uow.update(SETTINGS_TABLE_NAME, existing[0].id, (b) => b.set({ value }).check());
        } else {
          uow.create(SETTINGS_TABLE_NAME, {
            key: fullKey,
            value,
          });
        }

        // Await mutation phase - will throw if mutation fails
        await uow.mutationPhase;
      },

      async delete(id: FragnoId) {
        const uow = this.uow(internalSchema);
        uow.delete(SETTINGS_TABLE_NAME, id);
        await uow.mutationPhase;
      },
    });
  })
  .providesService("hookService", ({ defineService }) => {
    // TODO(Wilco): re-implement this better
    return defineService({
      /**
       * Get pending hook events for processing.
       * Returns all pending events for the given namespace that are ready to be processed.
       */
      async getPendingHookEvents(namespace: string): Promise<
        {
          id: FragnoId;
          hookName: string;
          payload: unknown;
          attempts: number;
          maxAttempts: number;
          nonce: string;
        }[]
      > {
        const uow = this.uow(internalSchema).find("fragno_hooks", (b) =>
          b.whereIndex("idx_namespace_status_retry", (eb) =>
            eb.and(eb("namespace", "=", namespace), eb("status", "=", "pending")),
          ),
        );

        const [events] = await uow.retrievalPhase;

        // Filter for pending status and events ready for retry
        const now = new Date();
        const ready = events.filter((event) => {
          // FIXME(Wilco): this should be handled by the database query, but there seems to be an issue.
          if (!event.nextRetryAt) {
            return true; // Newly created events (nextRetryAt = null) are ready
          }
          return event.nextRetryAt <= now; // Only include if retry time has passed
        });

        return ready.map((event) => ({
          id: event.id,
          hookName: event.hookName,
          payload: event.payload,
          attempts: event.attempts,
          maxAttempts: event.maxAttempts,
          nonce: event.nonce,
        }));
      },

      /**
       * Mark a hook event as completed.
       */
      markHookCompleted(eventId: FragnoId): void {
        const uow = this.uow(internalSchema);
        uow.update("fragno_hooks", eventId, (b) =>
          b.set({ status: "completed", lastAttemptAt: new Date() }).check(),
        );
      },

      /**
       * Mark a hook event as failed and schedule next retry.
       */
      markHookFailed(
        eventId: FragnoId,
        error: string,
        attempts: number,
        retryPolicy: RetryPolicy,
      ): void {
        const uow = this.uow(internalSchema);

        const newAttempts = attempts + 1;
        const shouldRetry = retryPolicy.shouldRetry(newAttempts - 1);

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
      },

      /**
       * Mark a hook event as processing (to prevent concurrent execution).
       */
      markHookProcessing(eventId: FragnoId): void {
        const uow = this.uow(internalSchema);
        uow.update("fragno_hooks", eventId, (b) =>
          b.set({ status: "processing", lastAttemptAt: new Date() }).check(),
        );
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
    const version = await fragment.inContext(async function () {
      const version = await this.uow(async ({ executeRetrieve }) => {
        const version = fragment.services.settingsService.get(namespace, "schema_version");
        await executeRetrieve();
        return version;
      });

      return version ? parseInt(version.value, 10) : 0;
    });
    return version;
  } catch {
    return 0;
  }
}
