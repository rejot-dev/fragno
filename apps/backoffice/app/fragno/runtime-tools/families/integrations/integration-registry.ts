import {
  integrationConnectionIdSchema,
  type IntegrationConnectionPage,
  type IntegrationSetupInput,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { z } from "zod";

import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";

import type {
  IntegrationCapability,
  IntegrationContext,
  IntegrationImplementation,
} from "./integration-implementation";

const integrationListingCursorSchema = z.strictObject({
  source: z.string().min(1),
  cursor: z.string().nullable(),
});

function requireCapability<TRun>(capability: IntegrationCapability<TRun>) {
  if (capability.kind === "unsupported") {
    throw new BackofficeUnavailableError(capability.reason);
  }
  return capability;
}

/** Registration reserves code-owned addresses, not credentials, connections, or retained runtime handles. */
export function createIntegrationRegistry(implementations: readonly IntegrationImplementation[]) {
  const exactOwners = new Map<string, IntegrationImplementation>();
  const namespaceOwners = new Map<string, IntegrationImplementation>();
  const entries = implementations.map((implementation) => {
    const firstClaim = implementation.connectionIds[0];
    if (!firstClaim) {
      throw new Error("Integrations registration requires a connection ID claim.");
    }
    for (const claim of implementation.connectionIds) {
      if (claim.kind === "exact") {
        integrationConnectionIdSchema.parse(claim.connectionId);
        if (exactOwners.has(claim.connectionId)) {
          throw new Error("Integrations registration has a duplicate exact connection ID.");
        }
        exactOwners.set(claim.connectionId, implementation);
      } else {
        // Validate namespaces against the same address grammar used at the public boundary.
        if (
          claim.namespace.includes("#") ||
          !integrationConnectionIdSchema.safeParse(`${claim.namespace}#_`).success
        ) {
          throw new Error("Integrations registration has an invalid connection namespace.");
        }
        if (namespaceOwners.has(claim.namespace)) {
          throw new Error("Integrations registration has a duplicate connection namespace.");
        }
        namespaceOwners.set(claim.namespace, implementation);
      }
    }
    return {
      key: firstClaim.kind === "exact" ? firstClaim.connectionId : `${firstClaim.namespace}#`,
      implementation,
    };
  });
  for (const connectionId of exactOwners.keys()) {
    const namespace = connectionId.slice(0, connectionId.indexOf("#"));
    if (namespaceOwners.has(namespace)) {
      throw new Error("Integrations registration has overlapping exact and namespace claims.");
    }
  }

  function findConnectionOwner(connectionId: string) {
    const namespace = connectionId.slice(0, connectionId.indexOf("#"));
    return exactOwners.get(connectionId) ?? namespaceOwners.get(namespace);
  }

  function resolveConnectionOwner(connectionId: string) {
    const implementation = findConnectionOwner(connectionId);
    if (!implementation) {
      throw new BackofficeOperationError("not_found", "Integrations connection not found.");
    }
    return { implementation, localId: connectionId.slice(connectionId.indexOf("#") + 1) };
  }

  function assertPublishedConnectionOwner(
    connectionId: string,
    implementation: IntegrationImplementation,
  ) {
    if (findConnectionOwner(connectionId) !== implementation) {
      throw new Error("Integrations source published a connection ID it does not own.");
    }
  }

  async function runProgressOperation(
    operationName: "setup" | "reconfigure",
    context: IntegrationContext,
    input: IntegrationSetupInput,
  ) {
    const { connectionId, ...operation } = input;
    const { implementation, localId } = resolveConnectionOwner(connectionId);
    const capability = requireCapability(implementation[operationName]);
    const progress = await capability.run(context, { localId, operation });
    // Setup input may choose another address of the same source, such as a new connection name.
    const movedSetup =
      operationName === "setup" && findConnectionOwner(progress.connectionId) === implementation;
    if (progress.connectionId !== connectionId && !movedSetup) {
      throw new Error(
        `Integrations source returned ${operationName} for a different connection ID.`,
      );
    }
    return progress;
  }

  return {
    /** Whether a registered source owns the address, configured or not. */
    claims(connectionId: string) {
      return findConnectionOwner(connectionId) !== undefined;
    },
    async discover(context: IntegrationContext) {
      return (
        await Promise.all(entries.map(({ implementation }) => implementation.discover(context)))
      ).flat();
    },
    async list(
      context: IntegrationContext,
      cursor: string | null,
    ): Promise<IntegrationConnectionPage> {
      let index = 0;
      let sourceCursor: string | null = null;
      if (cursor !== null) {
        let decoded: z.output<typeof integrationListingCursorSchema>;
        try {
          decoded = integrationListingCursorSchema.parse(JSON.parse(cursor));
        } catch {
          throw new BackofficeOperationError(
            "invalid_request",
            "Integrations listing cursor is invalid.",
          );
        }
        index = entries.findIndex((entry) => entry.key === decoded.source);
        if (index < 0) {
          throw new BackofficeOperationError(
            "invalid_request",
            "Integrations listing cursor is invalid.",
          );
        }
        sourceCursor = decoded.cursor;
      }
      // Sources are often cold Durable Objects, so they list in parallel and the slowest bounds the
      // page instead of their sum. Pages after the first source with more pages are discarded and
      // read again on the next request.
      const results = await Promise.all(
        entries.slice(index).map(async (entry, offset) => {
          const resumedCursor = offset === 0 ? sourceCursor : null;
          try {
            const page = await entry.implementation.list(context, resumedCursor);
            return { status: "listed" as const, entry, page };
          } catch (error) {
            // Skipping a resumed source would drop its remaining pages, so the caller retries the
            // cursor instead.
            if (resumedCursor !== null) {
              throw error;
            }
            // One failing source must not hide every other source's connections.
            const reason = error instanceof Error ? error.message : "The source could not list.";
            return { status: "unavailable" as const, entry, reason };
          }
        }),
      );
      // Finished sources are combined into one page, so a page stops only at a source with more
      // pages; each source's own page size still bounds the result.
      const connections: IntegrationConnectionPage["connections"] = [];
      const unavailableSources: IntegrationConnectionPage["unavailableSources"] = [];
      for (const result of results) {
        if (result.status === "unavailable") {
          unavailableSources.push({ source: result.entry.key, reason: result.reason });
          continue;
        }
        const { entry, page } = result;
        for (const connection of page.connections) {
          assertPublishedConnectionOwner(connection.connectionId, entry.implementation);
        }
        connections.push(...page.connections);
        if (page.cursor !== null) {
          return {
            connections,
            unavailableSources,
            cursor: JSON.stringify({ source: entry.key, cursor: page.cursor }),
          };
        }
      }
      return { connections, unavailableSources, cursor: null };
    },
    async resolve(context: IntegrationContext, connectionId: string) {
      const { implementation, localId } = resolveConnectionOwner(connectionId);
      const connection = await implementation.resolve(context, localId);
      if (connection.identity.connectionId !== connectionId) {
        throw new Error("Integrations source resolved a different connection ID.");
      }
      return connection;
    },
    setup(context: IntegrationContext, input: IntegrationSetupInput) {
      return runProgressOperation("setup", context, input);
    },
    reconfigure(context: IntegrationContext, input: IntegrationSetupInput) {
      return runProgressOperation("reconfigure", context, input);
    },
    async disconnect(context: IntegrationContext, connectionId: string) {
      const { implementation, localId } = resolveConnectionOwner(connectionId);
      const capability = requireCapability(implementation.disconnect);
      const result = await capability.run(context, { localId });
      if (result.connectionId !== connectionId) {
        throw new Error("Integrations source disconnected a different connection ID.");
      }
      return result;
    },
  };
}
