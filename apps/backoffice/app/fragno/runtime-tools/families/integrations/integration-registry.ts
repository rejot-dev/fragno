import { z } from "zod";

import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";

import {
  integrationConnectionIdSchema,
  type IntegrationConnectionPage,
  type IntegrationSetupInput,
} from "./integration-contracts";
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
      throw new Error("Integrations connection not found.");
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
    if (progress.connectionId !== connectionId) {
      throw new Error(
        `Integrations source returned ${operationName} for a different connection ID.`,
      );
    }
    return progress;
  }

  return {
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
          throw new Error("Integrations listing cursor is invalid.");
        }
        index = entries.findIndex((entry) => entry.key === decoded.source);
        if (index < 0) {
          throw new Error("Integrations listing cursor is invalid.");
        }
        sourceCursor = decoded.cursor;
      }
      for (; index < entries.length; index++) {
        const entry = entries[index];
        const page = await entry.implementation.list(context, sourceCursor);
        for (const connection of page.connections) {
          assertPublishedConnectionOwner(connection.connectionId, entry.implementation);
        }
        if (page.cursor !== null) {
          return {
            connections: page.connections,
            cursor: JSON.stringify({ source: entry.key, cursor: page.cursor }),
          };
        }
        if (page.connections.length > 0) {
          const next = entries[index + 1];
          return {
            connections: page.connections,
            cursor: next ? JSON.stringify({ source: next.key, cursor: null }) : null,
          };
        }
        sourceCursor = null;
      }
      return { connections: [], cursor: null };
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
