import { defineRoutes } from "@fragno-dev/core";

import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { DatabaseHandlerTx } from "../db-fragment-definition-builder";
import { FRAGNO_OUTBOX_PAGE_SIZE } from "../outbox/outbox";
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
const OUTBOX_STREAM_WRITE_TIMEOUT_MS = 1_000;
const OUTBOX_STREAM_MAX_LIFETIME_MS = 30_000;

type QueryLimitResult =
  | { ok: true; limit: number }
  | { ok: false; response: { error: string; code: "INVALID_LIMIT" }; status: 400 };

const parseLimitQueryParam = (limitValue: string | null): QueryLimitResult => {
  if (limitValue === null) {
    return { ok: true, limit: FRAGNO_OUTBOX_PAGE_SIZE };
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

        const afterVersionstamp = input.query.get("afterVersionstamp") ?? undefined;
        const limitResult = parseLimitQueryParam(input.query.get("limit"));
        if (!limitResult.ok) {
          return json(limitResult.response, { status: limitResult.status });
        }

        return jsonStream(async (stream) => {
          const streamId = crypto.randomUUID();
          const startedAt = Date.now();
          let pollCount = 0;
          let entriesRead = 0;
          let framesWritten = 0;
          let frameCharacters = 0;
          let largestFrameCharacters = 0;
          let heartbeatFrames = 0;
          let errorCount = 0;
          let completionReason: "aborted" | "expired" | "failed" = "failed";
          console.info("fragno.outbox_stream.started", { streamId });

          const writeOutboxStreamFrame = async (frame: string): Promise<boolean> => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let writeCompleted: boolean;
            try {
              writeCompleted = await Promise.race([
                stream.writeRaw(frame),
                new Promise<false>((resolve) => {
                  timeout = setTimeout(() => {
                    resolve(false);
                  }, OUTBOX_STREAM_WRITE_TIMEOUT_MS);
                  timeout.unref?.();
                }),
              ]);
            } catch (error) {
              await stream.abort();
              throw error;
            } finally {
              clearTimeout(timeout);
            }
            if (!writeCompleted) {
              await stream.abort();
            } else {
              framesWritten += 1;
              // Encoding again just to count wire bytes would inflate the heap being measured.
              frameCharacters += frame.length;
              largestFrameCharacters = Math.max(largestFrameCharacters, frame.length);
              if (frame === "\n") {
                heartbeatFrames += 1;
              }
            }
            return writeCompleted;
          };

          const handlerTx: DatabaseHandlerTx = (options) => this.handlerTx(options);
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

          const observer = registry.outboxObservationHub.registerOutboxObserver({
            observerId: streamId,
            afterVersionstamp,
            limit: limitResult.limit,
            writeFrame: writeOutboxStreamFrame,
            recordPoll: () => {
              pollCount += 1;
            },
            recordEntryRead: () => {
              entriesRead += 1;
            },
            recordError: () => {
              errorCount += 1;
            },
          });

          try {
            await observer.refreshNow(handlerTx);
            schedulerLease = observer.runWhile({
              signal: schedulerAbortController.signal,
              handlerTx,
            });
            // Some HTTP proxies continue draining a response after their client disconnects, so
            // cancellation alone cannot prove ownership. A finite lease bounds each observer's
            // scheduler ownership without stopping other connected observers.
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
            // Shared pump failures are counted before refreshNow rethrows them.
            if (observer.getFailure() !== error) {
              errorCount += 1;
            }
            throw error;
          } finally {
            observer.close();
            schedulerAbortController.abort();
            await schedulerLease;
            console.info("fragno.outbox_stream.completed", {
              streamId,
              durationMs: Date.now() - startedAt,
              pollCount,
              entriesRead,
              framesWritten,
              frameCharacters,
              largestFrameCharacters,
              heartbeatFrames,
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
              .transform(({ serviceResult: [entries] }) => entries)
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
