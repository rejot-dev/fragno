import { defineRoutes } from "@fragno-dev/core";
import { SETTINGS_NAMESPACE, internalFragmentDef } from "./internal-fragment";

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

        let adapterIdentity: string;
        try {
          const existingIdentity = await this.handlerTx()
            .withServiceCalls(
              () =>
                [services.settingsService.get(SETTINGS_NAMESPACE, ADAPTER_IDENTITY_KEY)] as const,
            )
            .transform(({ serviceResult: [result] }) => result?.value)
            .execute();

          if (existingIdentity) {
            adapterIdentity = existingIdentity;
          } else {
            adapterIdentity = crypto.randomUUID();
            await this.handlerTx()
              .withServiceCalls(
                () =>
                  [
                    services.settingsService.set(
                      SETTINGS_NAMESPACE,
                      ADAPTER_IDENTITY_KEY,
                      adapterIdentity,
                    ),
                  ] as const,
              )
              .execute();
          }
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

        const outboxEnabled = registry.isOutboxEnabled();
        const response: InternalDescribeResponse = {
          adapterIdentity,
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
