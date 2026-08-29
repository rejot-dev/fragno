import { defineRoutes } from "@fragno-dev/core";

import type { StandardSchemaV1 } from "@standard-schema/spec";

import { BufferedDatabasePump } from "../buffered-pump";
import type { DatabaseHandlerTx } from "../db-fragment-definition-builder";
import { FRAGNO_OUTBOX_PAGE_SIZE, type OutboxEntry } from "../outbox/outbox";
import { submitSyncRequest, type SyncRequestRecord } from "../sync/submit";
import type { SubmitRequest, SyncCommandDefinition } from "../sync/types";
import {
  SETTINGS_NAMESPACE,
  internalFragmentDef,
  internalSchema,
  type InternalFragmentInstance,
} from "./internal-fragment";

type InternalDescribeResponse = {
  adapterIdentity: string;
  currentVersionstamp: string | null;
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
    outboxStream?: "/_internal/outbox/stream";
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
const OUTBOX_STREAM_PUMP_INTERVAL_MS = 300;
const OUTBOX_STREAM_WRITE_TIMEOUT_MS = 1_000;
const OUTBOX_STREAM_MAX_LIFETIME_MS = 30_000;

type QueryLimitResult =
  | { ok: true; limit: number | undefined }
  | { ok: false; response: { error: string; code: "INVALID_LIMIT" }; status: 400 };

const parseLimitQueryParam = (limitValue: string | null): QueryLimitResult => {
  if (limitValue === null) {
    return { ok: true, limit: undefined };
  }

  const parsed = Number.parseInt(limitValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > FRAGNO_OUTBOX_PAGE_SIZE) {
    return {
      ok: false,
      response: {
        error: `Limit query parameter must be between 1 and ${FRAGNO_OUTBOX_PAGE_SIZE}.`,
        code: "INVALID_LIMIT",
      },
      status: 400,
    };
  }

  return { ok: true, limit: parsed };
};

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
  handlerTx: DatabaseHandlerTx,
  services: Pick<InternalFragmentInstance["services"], "settingsService">,
): Promise<AdapterIdentityResult> => {
  try {
    const generatedIdentity = crypto.randomUUID();
    const adapterIdentity = await handlerTx({ name: "internal.adapterIdentity.getOrCreate" })
      .withServiceCalls(
        () =>
          [
            services.settingsService.getOrCreate(
              SETTINGS_NAMESPACE,
              ADAPTER_IDENTITY_KEY,
              generatedIdentity,
            ),
          ] as const,
      )
      .transform(({ serviceResult: [identity] }) => identity)
      .execute();
    return { ok: true, value: adapterIdentity };
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

        const outboxEnabled = registry.isOutboxEnabled();
        const generatedIdentity = crypto.randomUUID();
        let adapterIdentity: string;
        let currentVersionstamp: string | null;
        try {
          ({ adapterIdentity, currentVersionstamp } = await this.handlerTx({
            name: "internal.describe",
          })
            .withServiceCalls(
              () =>
                [
                  services.settingsService.getOrCreate(
                    SETTINGS_NAMESPACE,
                    ADAPTER_IDENTITY_KEY,
                    generatedIdentity,
                  ),
                  services.outboxService.latestVersionstamp(),
                ] as const,
            )
            .transform(({ serviceResult: [identity, versionstamp] }) => ({
              adapterIdentity: identity,
              currentVersionstamp: outboxEnabled ? versionstamp : null,
            }))
            .execute());
        } catch (error) {
          return json(
            {
              error: {
                code: "SETTINGS_UNAVAILABLE",
                message: "Internal settings table is not available.",
                detail: error instanceof Error ? error.message : undefined,
              },
            } satisfies InternalDescribeError,
            { status: 500 },
          );
        }

        const response: InternalDescribeResponse = {
          adapterIdentity,
          currentVersionstamp,
          fragments: outboxEnabled ? registry.listOutboxFragments() : [],
          schemas: registry.listSchemas(),
          routes: {
            internal: "/_internal",
            outbox: outboxEnabled ? "/_internal/outbox" : undefined,
            outboxStream: outboxEnabled ? "/_internal/outbox/stream" : undefined,
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
        const limitResult = parseLimitQueryParam(input.query.get("limit"));
        if (!limitResult.ok) {
          return json(limitResult.response, { status: limitResult.status });
        }

        const limit = limitResult.limit;

        const entries = await this.handlerTx({ name: "internal.outbox.list" })
          .withServiceCalls(
            () => [services.outboxService.list({ afterVersionstamp, limit })] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        return json(entries);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/outbox/stream",
      handler: async function (input, { json, jsonStream }) {
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

        let afterVersionstamp = input.query.get("afterVersionstamp") ?? undefined;
        const limitResult = parseLimitQueryParam(input.query.get("limit"));
        if (!limitResult.ok) {
          return json(limitResult.response, { status: limitResult.status });
        }

        const listEntries = async (handlerTx: DatabaseHandlerTx): Promise<OutboxEntry[]> => {
          const entries = await handlerTx({ name: "internal.outbox.stream.list" })
            .withServiceCalls(
              () =>
                [
                  services.outboxService.list({
                    afterVersionstamp,
                    limit: limitResult.limit,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result as OutboxEntry[])
            .execute();

          afterVersionstamp = entries[entries.length - 1]?.versionstamp ?? afterVersionstamp;
          return entries;
        };

        const initialEntries = await listEntries((options) => this.handlerTx(options));

        return jsonStream(async (stream) => {
          const streamId = crypto.randomUUID();
          const startedAt = Date.now();
          let pollCount = 0;
          let entriesRead = initialEntries.length;
          let errorCount = 0;
          let completionReason: "aborted" | "expired" | "failed" = "failed";
          console.info("fragno.outbox_stream.started", {
            streamId,
            initialEntryCount: initialEntries.length,
          });

          const writeOutboxStreamFrame = async (frame: string): Promise<boolean> => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const writeCompleted = await Promise.race([
              stream.writeRaw(frame),
              new Promise<false>((resolve) => {
                timeout = setTimeout(() => {
                  resolve(false);
                }, OUTBOX_STREAM_WRITE_TIMEOUT_MS);
                timeout.unref?.();
              }),
            ]);
            clearTimeout(timeout);
            if (!writeCompleted) {
              await stream.abort();
            }
            return writeCompleted;
          };

          const handlerTx: DatabaseHandlerTx = (options) => this.handlerTx(options);
          const pump = new BufferedDatabasePump<never, never, OutboxEntry>({
            intervalMs: OUTBOX_STREAM_PUMP_INTERVAL_MS,
            cursorForObservedItem: (entry) => entry.versionstamp,
            onError: (error) => {
              errorCount += 1;
              console.error("[outbox-stream] flush failed", error);
            },
            flush: async ({ handlerTx }) => {
              pollCount += 1;
              const entries = await listEntries(handlerTx);
              entriesRead += entries.length;
              if (entries.length === 0) {
                await writeOutboxStreamFrame("\n");
              }
              return { observedItems: entries };
            },
          });

          let stopObserving = () => {};
          let schedulerLease: Promise<void> | undefined;
          const schedulerAbortController = new AbortController();
          const waitForAbort = new Promise<void>((resolve) => {
            stream.onAbort(() => {
              if (completionReason !== "expired") {
                completionReason = "aborted";
              }
              schedulerAbortController.abort();
              resolve();
            });
          });

          stopObserving = pump.observe(async (entry) => {
            await writeOutboxStreamFrame(`${JSON.stringify(entry)}\n`);
          });

          try {
            for (const entry of initialEntries) {
              if (!(await writeOutboxStreamFrame(`${JSON.stringify(entry)}\n`))) {
                break;
              }
            }
            await pump.flushNow(handlerTx);
            schedulerLease = pump.runWhile({
              kind: "observer",
              signal: schedulerAbortController.signal,
              handlerTx,
            });
            // Some HTTP proxies continue draining a response after their client disconnects, so
            // cancellation alone cannot prove ownership. A finite lease bounds every polling pump.
            let streamLeaseTimeout: ReturnType<typeof setTimeout> | undefined;
            const waitForStreamLeaseExpiry = new Promise<true>((resolve) => {
              streamLeaseTimeout = setTimeout(() => {
                resolve(true);
              }, OUTBOX_STREAM_MAX_LIFETIME_MS);
              streamLeaseTimeout.unref?.();
            });
            const streamExpired = await Promise.race([
              waitForAbort.then(() => {
                return false;
              }),
              waitForStreamLeaseExpiry,
            ]);
            clearTimeout(streamLeaseTimeout);
            if (streamExpired) {
              completionReason = "expired";
              await stream.abort();
            }
          } catch (error) {
            // Buffered pump failures are counted by onError before flushNow rethrows them.
            if (pump.getFailure() !== error) {
              errorCount += 1;
            }
            throw error;
          } finally {
            stopObserving();
            schedulerAbortController.abort();
            await schedulerLease;
            await pump.drain();
            console.info("fragno.outbox_stream.completed", {
              streamId,
              durationMs: Date.now() - startedAt,
              pollCount,
              entriesRead,
              errorCount,
              completionReason,
            });
          }
        });
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
          (options) => this.handlerTx(options),
          services,
        );
        if (!adapterIdentityResult.ok) {
          return json(adapterIdentityResult.error, { status: 500 });
        }

        const body = (await input.input?.valid()) as SubmitRequest | undefined;

        const result = await submitSyncRequest(body, {
          getAdapterIdentity: async () => adapterIdentityResult.value,
          listOutboxEntries: async (afterVersionstamp) =>
            await this.handlerTx({ name: "internal.sync.listOutboxEntries" })
              .withServiceCalls(
                () =>
                  [services.outboxService.list({ afterVersionstamp, limit: undefined })] as const,
              )
              .transform(({ serviceResult: [entries] }) => entries as OutboxEntry[])
              .execute(),
          countOutboxMutations: async (afterVersionstamp) => {
            const count = await this.handlerTx({ name: "internal.sync.countOutboxMutations" })
              .retrieve(({ forSchema }) => {
                const builder = afterVersionstamp
                  ? forSchema(internalSchema).find("fragno_db_outbox_mutations", (b) =>
                      b
                        .whereIndex("idx_outbox_mutations_entry", (eb) =>
                          eb("entryVersionstamp", ">", afterVersionstamp),
                        )
                        .selectCount(),
                    )
                  : forSchema(internalSchema).find("fragno_db_outbox_mutations", (b) =>
                      b.whereIndex("idx_outbox_mutations_entry").selectCount(),
                    );
                return builder;
              })
              .transformRetrieve(([result]) => (typeof result === "number" ? result : 0))
              .execute();
            return count;
          },
          getSyncRequest: async (requestId) =>
            await this.handlerTx({ name: "internal.sync.getRequest" })
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
            await this.handlerTx({ name: "internal.sync.storeRequest" })
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
              tx: (options) =>
                this.handlerTx({
                  ...options,
                  name: options?.name ?? `internal.sync.command.${command.name}`,
                }),
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
