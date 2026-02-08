import { defineRoutes, defaultFragnoRuntime } from "@fragno-dev/core";
import {
  ADAPTER_IDENTITY_KEY,
  SETTINGS_NAMESPACE,
  internalFragmentDef,
  internalSchema,
} from "./internal-fragment";
import { resolveAdapterIdentity } from "../registry/adapter-registry";

type AdapterIdentityResponse = {
  id: string;
  source: "settings";
};

type InternalDescribeResponse = {
  adapterIdentity: AdapterIdentityResponse;
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

export const internalFragmentDescribeRoutes = defineRoutes(internalFragmentDef).create(
  ({ defineRoute, services, config }) => [
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

        let identity: string | undefined;
        try {
          identity = await resolveAdapterIdentity({
            handlerTx: () => this.handlerTx(),
            settingsService: services.settingsService,
            randomUuid: () => defaultFragnoRuntime.random.uuid(),
            settingsNamespace: SETTINGS_NAMESPACE,
            identityKey: ADAPTER_IDENTITY_KEY,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return json(
            {
              error: {
                code: "ADAPTER_IDENTITY_UNAVAILABLE",
                message: "Failed to resolve adapter identity.",
                detail,
              },
            } satisfies InternalDescribeError,
            { status: 500 },
          );
        }

        if (!identity) {
          return json(
            {
              error: {
                code: "ADAPTER_IDENTITY_UNAVAILABLE",
                message: "Failed to persist adapter identity.",
              },
            } satisfies InternalDescribeError,
            { status: 500 },
          );
        }

        const schemas = registry
          .listSchemas()
          .filter((schemaInfo) => schemaInfo.name !== internalSchema.name);

        const response: InternalDescribeResponse = {
          adapterIdentity: { id: identity, source: "settings" },
          fragments: registry.listFragments(),
          schemas,
          routes: {
            internal: "/_internal",
            outbox: config.outbox?.enabled ? "/_internal/outbox" : undefined,
          },
        };

        return json(response);
      },
    }),
  ],
);

export const internalFragmentOutboxRoutes = defineRoutes(internalFragmentDef).create(
  ({ defineRoute, services }) => [
    defineRoute({
      method: "GET",
      path: "/outbox",
      handler: async function (input, { json }) {
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
  ],
);
