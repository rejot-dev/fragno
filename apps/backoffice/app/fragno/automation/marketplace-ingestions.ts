import { z } from "zod";

import {
  backofficeOrganisationScopeSchema,
  backofficeProjectScopeSchema,
  backofficeUserScopeSchema,
} from "@/backoffice-runtime/context-schema";
import {
  backofficeScopeSinglePathSegment,
  type BackofficeRoutableScope,
} from "@/backoffice-runtime/scope-codec";
import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
  type MarketplaceArtifactManifest,
} from "@/fragno/marketplace/contracts";

import type { AutomationHookServiceContext } from "./internal-hooks";
import { automationFragmentSchema } from "./schema";

const marketplaceIngestionTargetScopeSchema = z.discriminatedUnion("kind", [
  backofficeOrganisationScopeSchema,
  backofficeProjectScopeSchema,
  backofficeUserScopeSchema,
]);

export const marketplaceIngestionTargetScopeKey = (scope: BackofficeRoutableScope): string =>
  backofficeScopeSinglePathSegment(scope);

const marketplaceIngestionId = (input: {
  targetScope: BackofficeRoutableScope;
  listingId: string;
}): string =>
  `${marketplaceIngestionTargetScopeKey(input.targetScope)}#${marketplaceListingIdSchema.parse(input.listingId)}`;

export type MarketplaceIngestionRecord = {
  id: string;
  targetScopeKey: string;
  listingId: string;
  version: string;
};

const marketplaceIngestionLookupInputSchema = z.object({
  targetScope: marketplaceIngestionTargetScopeSchema,
  listingId: marketplaceListingIdSchema,
});

export type MarketplaceIngestionLookupInput = z.infer<typeof marketplaceIngestionLookupInputSchema>;

const marketplaceIngestionListInputSchema = z
  .object({ targetScope: marketplaceIngestionTargetScopeSchema.optional() })
  .optional()
  .transform((input) => input ?? {});

export type MarketplaceIngestionListInput = z.input<typeof marketplaceIngestionListInputSchema>;

const marketplaceIngestionUpsertInputSchema = marketplaceIngestionLookupInputSchema.extend({
  version: marketplaceVersionSchema,
  expectedVersion: marketplaceVersionSchema.nullable(),
});

type MarketplaceIngestionUpsertInput = z.infer<typeof marketplaceIngestionUpsertInputSchema>;

export class MarketplaceIngestionStateConflictError extends Error {
  constructor(
    readonly listingId: string,
    readonly expectedVersion: string | null,
    readonly actualVersion: string | null,
  ) {
    super(
      `Marketplace ingestion '${listingId}' expected installed version '${expectedVersion ?? "none"}', but found '${actualVersion ?? "none"}'.`,
    );
    this.name = "MarketplaceIngestionStateConflictError";
  }
}

export const marketplaceIngestionRequestInputSchema = z.object({
  targetScope: marketplaceIngestionTargetScopeSchema,
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema.optional(),
});

export type MarketplaceIngestionRequestInput = z.infer<
  typeof marketplaceIngestionRequestInputSchema
>;

export const marketplaceIngestionWorkflowInputSchema =
  marketplaceIngestionRequestInputSchema.extend({
    version: marketplaceVersionSchema,
  });

export class MarketplaceIngestionTargetAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceIngestionTargetAccessError";
  }
}

export class MarketplaceIngestionArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceIngestionArtifactUnavailableError";
  }
}

export const assertMarketplaceIngestionTargetBelongsToOrganization = (input: {
  organizationId: string;
  targetScope: BackofficeRoutableScope;
}): void => {
  if (
    (input.targetScope.kind === "org" || input.targetScope.kind === "project") &&
    input.targetScope.orgId !== input.organizationId
  ) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion target belongs to another organization.",
    );
  }
};

export const assertMarketplaceIngestionTargetAccessible = async (input: {
  organizationId: string;
  targetScope: BackofficeRoutableScope;
  projectExists: (projectId: string) => Promise<boolean>;
  organizationHasMember: (userId: string) => Promise<boolean>;
}): Promise<void> => {
  assertMarketplaceIngestionTargetBelongsToOrganization(input);

  if (
    input.targetScope.kind === "project" &&
    !(await input.projectExists(input.targetScope.projectId))
  ) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion project target was not found.",
    );
  }

  if (
    input.targetScope.kind === "user" &&
    !(await input.organizationHasMember(input.targetScope.userId))
  ) {
    throw new MarketplaceIngestionTargetAccessError(
      "Marketplace ingestion user target is not a member of the organization.",
    );
  }
};

export const resolveMarketplaceIngestionArtifactVersion = (
  manifest: MarketplaceArtifactManifest | null,
  requestedVersion: string | undefined,
): {
  manifest: MarketplaceArtifactManifest;
  version: MarketplaceArtifactManifest["versions"][number];
} => {
  if (manifest?.listingStatus !== "published") {
    throw new MarketplaceIngestionArtifactUnavailableError("Marketplace listing is not published.");
  }

  const version = requestedVersion ?? manifest.versions[0]?.version;
  const selected = manifest.versions.find((candidate) => candidate.version === version);
  if (!selected) {
    throw new MarketplaceIngestionArtifactUnavailableError(
      `Marketplace version '${requestedVersion ?? "latest"}' is not available.`,
    );
  }

  return { manifest, version: selected };
};

type MarketplaceIngestionRequestIdentity = {
  listingId: string;
  version: string;
  workflowInstanceId: string;
};

export type MarketplaceIngestionRequestResult = MarketplaceIngestionRequestIdentity &
  (
    | { state: "ingested" }
    | { state: "requested"; workflowStatus: "active" }
    | { state: "pending"; workflowStatus: "active" | "waiting" | "paused" }
    | {
        state: "failed";
        workflowStatus: "errored" | "terminated" | "complete";
        error: { name: string; message: string };
      }
  );

const serializeMarketplaceIngestion = (row: {
  id: { valueOf(): string };
  targetScopeKey: string;
  listingId: string;
  version: string;
}): MarketplaceIngestionRecord => ({
  id: row.id.valueOf(),
  targetScopeKey: row.targetScopeKey,
  listingId: row.listingId,
  version: row.version,
});

export const createAutomationMarketplaceIngestionServices = (
  defineService: <TService>(service: TService & ThisType<AutomationHookServiceContext>) => TService,
) =>
  defineService({
    getMarketplaceIngestion(args: MarketplaceIngestionLookupInput) {
      const input = marketplaceIngestionLookupInputSchema.parse(args);
      const id = marketplaceIngestionId(input);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("marketplace_ingestion", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .transformRetrieve(([row]) => (row ? serializeMarketplaceIngestion(row) : null))
        .build();
    },

    listMarketplaceIngestions(args?: MarketplaceIngestionListInput) {
      const input = marketplaceIngestionListInputSchema.parse(args);
      const targetScopeKey = input.targetScope
        ? marketplaceIngestionTargetScopeKey(input.targetScope)
        : undefined;
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("marketplace_ingestion", (b) =>
            targetScopeKey
              ? b.whereIndex("idx_marketplace_ingestion_targetScopeKey_id", (eb) =>
                  eb("targetScopeKey", "=", targetScopeKey),
                )
              : b.whereIndex("primary"),
          ),
        )
        .transformRetrieve(([rows]) => rows.map(serializeMarketplaceIngestion))
        .build();
    },

    upsertMarketplaceIngestion(args: MarketplaceIngestionUpsertInput) {
      const input = marketplaceIngestionUpsertInputSchema.parse(args);
      const id = marketplaceIngestionId(input);
      const targetScopeKey = marketplaceIngestionTargetScopeKey(input.targetScope);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("marketplace_ingestion", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }): MarketplaceIngestionRecord => {
          if (existing?.version === input.version) {
            return serializeMarketplaceIngestion(existing);
          }

          const actualVersion = existing?.version ?? null;
          if (actualVersion !== input.expectedVersion) {
            throw new MarketplaceIngestionStateConflictError(
              input.listingId,
              input.expectedVersion,
              actualVersion,
            );
          }

          if (existing) {
            uow.update("marketplace_ingestion", existing.id, (b) =>
              b.set({ version: input.version }).check(),
            );
          } else {
            uow.create(
              "marketplace_ingestion",
              {
                id,
                targetScopeKey,
                listingId: input.listingId,
                version: input.version,
              },
              {
                retryOnUniqueConflict: ({ error }) =>
                  error.columns?.length === 1 && error.columns[0] === "id",
              },
            );
          }

          return serializeMarketplaceIngestion({ id, targetScopeKey, ...input });
        })
        .build();
    },
  });
