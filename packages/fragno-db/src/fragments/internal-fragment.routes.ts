import { defineRoutes } from "@fragno-dev/core";
import { internalFragmentDef } from "./internal-fragment";

export const internalFragmentRoutes = defineRoutes(internalFragmentDef).create(
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
