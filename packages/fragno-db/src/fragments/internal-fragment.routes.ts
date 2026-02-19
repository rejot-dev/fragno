import { defineRoutes } from "@fragno-dev/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  SETTINGS_NAMESPACE,
  internalFragmentDef,
  internalSchema,
  type InternalFragmentInstance,
} from "./internal-fragment";
import { submitSyncRequest, type SyncRequestRecord } from "../sync/submit";
import type { SubmitRequest, SyncCommandDefinition } from "../sync/types";
import type { DatabaseHandlerContext } from "../db-fragment-definition-builder";
import type { OutboxEntry } from "../outbox/outbox";
import type { ConditionBuilder } from "../query/condition-builder";
import type { AnyColumn } from "../schema/create";
import { resolveShardValue } from "../sharding";

type InternalDescribeResponse = {
  adapterIdentity: string;
  fragments: Array<{ name: string; mountRoute: string }>;
  schemas: Array<{
    name: string;
    namespace: string | null;
    version: number;
    tables: string[];
  }>;
  routes: {
    internal: "/_internal";
    outbox?: "/_internal/outbox";
  };
};

type InternalDescribeError = {
  error: {
    code: string;
    message: string;
    detail?: string;
  };
};

const ADAPTER_IDENTITY_KEY = "adapter_identity" as const;

const passthroughInputSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "fragno",
    validate: async (value: unknown) => ({ value }),
  },
};

type AdapterIdentityResult =
  | { ok: true; value: string }
  | { ok: false; error: InternalDescribeError };

const getOrCreateAdapterIdentity = async (
  handlerTx: () => ReturnType<DatabaseHandlerContext["handlerTx"]>,
  services: Pick<InternalFragmentInstance["services"], "settingsService">,
): Promise<AdapterIdentityResult> => {
  const readIdentity = async () =>
    handlerTx()
      .withServiceCalls(
        () => [services.settingsService.get(SETTINGS_NAMESPACE, ADAPTER_IDENTITY_KEY)] as const,
      )
      .transform(({ serviceResult: [result] }) => result?.value as string | undefined)
      .execute();

  try {
    const existingIdentity = await readIdentity();
    if (existingIdentity) {
      return { ok: true, value: existingIdentity };
    }

    const adapterIdentity = crypto.randomUUID();
    try {
      await handlerTx()
        .withServiceCalls(
          () =>
            [
              services.settingsService.setIfMissing(
                SETTINGS_NAMESPACE,
                ADAPTER_IDENTITY_KEY,
                adapterIdentity,
              ),
            ] as const,
        )
        .execute();
    } catch (error) {
      const recoveredIdentity = await readIdentity();
      if (recoveredIdentity) {
        return { ok: true, value: recoveredIdentity };
      }
      throw error;
    }

    const persistedIdentity = await readIdentity();
    return { ok: true, value: persistedIdentity ?? adapterIdentity };
  } catch (error) {
    return {
      ok: false,
      error: {
        error: {
          code: "SETTINGS_UNAVAILABLE",
          message: "Internal settings table is not available.",
          detail: error instanceof Error ? error.message : undefined,
        },
      },
    };
  }
};

export const createInternalFragmentDescribeRoutes = () =>
  defineRoutes(internalFragmentDef).create(({ defineRoute, config, services }) => [
    defineRoute({
      method: "GET",
      path: "/",
      handler: async function (_input, { json }) {
        const registry = config.registry;
        if (!registry) {
          return json(
            {
              error: {
                code: "REGISTRY_UNAVAILABLE",
                message: "Adapter registry is not configured.",
              },
            } satisfies InternalDescribeError,
            { status: 500 },
          );
        }

        const adapterIdentityResult = await getOrCreateAdapterIdentity(
          () => this.handlerTx(),
          services,
        );
        if (!adapterIdentityResult.ok) {
          return json(adapterIdentityResult.error, { status: 500 });
        }

        const outboxEnabled = registry.isOutboxEnabled();
        const response: InternalDescribeResponse = {
          adapterIdentity: adapterIdentityResult.value,
          fragments: outboxEnabled ? registry.listOutboxFragments() : [],
          schemas: registry.listSchemas(),
          routes: {
            internal: "/_internal",
            outbox: outboxEnabled ? "/_internal/outbox" : undefined,
          },
        };

        return json(response);
      },
    }),
  ]);

export const createInternalFragmentOutboxRoutes = () =>
  defineRoutes(internalFragmentDef).create(({ defineRoute, services, config }) => [
    defineRoute({
      method: "GET",
      path: "/outbox",
      handler: async function (input, { json }) {
        const registry = config.registry;
        if (!registry || !registry.isOutboxEnabled()) {
          return json(
            {
              error: {
                code: "OUTBOX_UNAVAILABLE",
                message: "Outbox is not enabled for this adapter.",
              },
            },
            { status: 404 },
          );
        }

        // We intentionally skip input/output schemas here to keep the internal route lightweight.
        // Query params are validated manually and the response shape is stable (OutboxEntry[]),
        // while the public API surface is still gated behind adapter config.
        const afterVersionstamp = input.query.get("afterVersionstamp") ?? undefined;
        const limitValue = input.query.get("limit");
        let limit: number | undefined;

        if (limitValue !== null) {
          const parsed = Number.parseInt(limitValue, 10);
          if (!Number.isFinite(parsed) || parsed < 1) {
            return json(
              {
                error: "Invalid limit query parameter.",
                code: "INVALID_LIMIT",
              },
              { status: 400 },
            );
          }
          limit = parsed;
        }

        const entries = await this.handlerTx()
          .withServiceCalls(
            () => [services.outboxService.list({ afterVersionstamp, limit })] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        return json(entries);
      },
    }),
  ]);

type InternalSyncError = {
  error: {
    code: string;
    message: string;
    detail?: string;
  };
};

export const createInternalFragmentSyncRoutes = () =>
  defineRoutes(internalFragmentDef).create(({ defineRoute, services, config }) => [
    defineRoute({
      method: "POST",
      path: "/sync",
      inputSchema: passthroughInputSchema,
      handler: async function (input, { json }) {
        const registry = config.registry;
        if (!registry || !registry.isOutboxEnabled()) {
          return json(
            {
              error: {
                code: "SYNC_UNAVAILABLE",
                message: "Sync is not enabled for this adapter.",
              },
            } satisfies InternalSyncError,
            { status: 404 },
          );
        }

        const adapterIdentityResult = await getOrCreateAdapterIdentity(
          () => this.handlerTx(),
          services,
        );
        if (!adapterIdentityResult.ok) {
          return json(adapterIdentityResult.error, { status: 500 });
        }

        const shard = this.getShard();
        const shardScope = this.getShardScope();
        const shardingStrategy = registry.shardingStrategy;
        const shouldApplyShardFilter = shardingStrategy?.mode === "row" && shardScope === "scoped";

        const body = (await input.input?.valid()) as SubmitRequest | undefined;

        const result = await submitSyncRequest(body, {
          getAdapterIdentity: async () => adapterIdentityResult.value,
          listOutboxEntries: async (afterVersionstamp) =>
            await this.handlerTx()
              .withServiceCalls(
                () =>
                  [services.outboxService.list({ afterVersionstamp, limit: undefined })] as const,
              )
              .transform(({ serviceResult: [entries] }) => entries as OutboxEntry[])
              .execute(),
          countOutboxMutations: async (afterVersionstamp) => {
            const count = await this.handlerTx()
              .retrieve(({ forSchema }) => {
                if (shouldApplyShardFilter) {
                  return forSchema(internalSchema).find("fragno_db_outbox_mutations", (b) => {
                    if (afterVersionstamp) {
                      return b
                        .whereIndex("idx_outbox_mutations_shard_entry", ((
                          eb: ConditionBuilder<Record<string, AnyColumn>>,
                        ) =>
                          eb.and(
                            eb("_shard", "=", resolveShardValue(shard)),
                            eb("entryVersionstamp", ">", afterVersionstamp),
                          )) as never)
                        .selectCount();
                    }

                    return b
                      .whereIndex("idx_outbox_mutations_shard_entry", ((
                        eb: ConditionBuilder<Record<string, AnyColumn>>,
                      ) => eb("_shard", "=", resolveShardValue(shard))) as never)
                      .selectCount();
                  });
                }

                if (afterVersionstamp) {
                  return forSchema(internalSchema).find("fragno_db_outbox_mutations", (b) =>
                    b
                      .whereIndex("idx_outbox_mutations_entry", (eb) =>
                        eb("entryVersionstamp", ">", afterVersionstamp),
                      )
                      .selectCount(),
                  );
                }

                return forSchema(internalSchema).find("fragno_db_outbox_mutations", (b) =>
                  b.whereIndex("idx_outbox_mutations_entry").selectCount(),
                );
              })
              .transformRetrieve(([result]) => (typeof result === "number" ? result : 0))
              .execute();
            return count;
          },
          getSyncRequest: async (requestId) =>
            await this.handlerTx()
              .retrieve(({ forSchema }) =>
                forSchema(internalSchema).findFirst("fragno_db_sync_requests", (b) =>
                  b.whereIndex("idx_sync_request_id", (eb) => eb("requestId", "=", requestId)),
                ),
              )
              .transformRetrieve(([result]) => {
                if (!result) {
                  return undefined;
                }
                const confirmed = Array.isArray(result.confirmedCommandIds)
                  ? (result.confirmedCommandIds as string[])
                  : [];
                const status = result.status === "applied" ? "applied" : "conflict";
                return {
                  requestId: result.requestId,
                  status,
                  confirmedCommandIds: confirmed,
                  conflictCommandId: result.conflictCommandId ?? undefined,
                  baseVersionstamp: result.baseVersionstamp ?? undefined,
                  lastVersionstamp: result.lastVersionstamp ?? undefined,
                } satisfies SyncRequestRecord;
              })
              .execute(),
          storeSyncRequest: async (record) => {
            await this.handlerTx()
              .mutate(({ forSchema }) => {
                forSchema(internalSchema).create("fragno_db_sync_requests", {
                  requestId: record.requestId,
                  status: record.status,
                  confirmedCommandIds: record.confirmedCommandIds,
                  conflictCommandId: record.conflictCommandId ?? null,
                  baseVersionstamp: record.baseVersionstamp ?? null,
                  lastVersionstamp: record.lastVersionstamp ?? null,
                });
              })
              .execute();
          },
          resolveCommand: (fragment, schema, name) =>
            registry.resolveSyncCommand(fragment, schema, name) as
              | { command: SyncCommandDefinition; namespace: string | null }
              | undefined,
          createCommandContext: (command) =>
            command.createServerContext?.(this) ?? { mode: "server" },
          executeCommand: async (command, inputPayload, ctx) => {
            await command.handler({
              input: inputPayload,
              ctx,
              tx: (options) => this.handlerTx(options),
            });
          },
        });

        if (result.status === "error") {
          const statusCode = result.statusCode as 400 | 409 | 500;
          return json(result.body, { status: statusCode });
        }

        return json(result.response);
      },
    }),
  ]);
