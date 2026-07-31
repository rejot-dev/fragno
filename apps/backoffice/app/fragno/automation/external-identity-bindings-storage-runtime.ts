import type { TableToColumnValues } from "@fragno-dev/db/query";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import {
  bindExternalIdentityInputSchema,
  buildExternalIdentityBindingId,
  ExternalIdentityBindingConflictError,
  getExternalIdentityBindingInputSchema,
  revokeExternalIdentityInputSchema,
  type BindExternalIdentityInput,
  type BindExternalIdentityResult,
  type ExternalIdentityBinding,
  type GetExternalIdentityBindingInput,
  type RevokeExternalIdentityInput,
  type RevokeExternalIdentityResult,
} from "./external-identities";
import { automationFragmentSchema } from "./schema";

type ExternalIdentityBindingServiceContext = DatabaseServiceContext<Record<string, never>>;
type ExternalIdentityBindingRow = TableToColumnValues<
  typeof automationFragmentSchema.tables.external_identity_binding
>;

const toExternalIdentityBinding = (row: ExternalIdentityBindingRow): ExternalIdentityBinding => {
  const binding = {
    id: row.id.valueOf(),
    version: row.id.version,
    identity: {
      scope: "external" as const,
      source: row.source,
      type: row.externalType,
      id: row.externalId,
    },
    userId: row.userId,
    verifiedByClaimId: row.verifiedByClaimId,
    boundAt: row.boundAt,
  };

  return row.revokedAt
    ? { ...binding, status: "revoked", revokedAt: row.revokedAt }
    : { ...binding, status: "active" };
};

export const createExternalIdentityBindingServices = (
  defineService: <TService>(
    service: TService & ThisType<ExternalIdentityBindingServiceContext>,
  ) => TService,
) =>
  defineService({
    getExternalIdentityBinding(args: GetExternalIdentityBindingInput) {
      const input = getExternalIdentityBindingInputSchema.parse(args);
      const bindingId = buildExternalIdentityBindingId(input.identity);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("external_identity_binding", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", bindingId)),
          ),
        )
        .transformRetrieve(([binding]) => (binding ? toExternalIdentityBinding(binding) : null))
        .build();
    },

    resolveExternalIdentity(args: GetExternalIdentityBindingInput) {
      const input = getExternalIdentityBindingInputSchema.parse(args);
      const bindingId = buildExternalIdentityBindingId(input.identity);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("external_identity_binding", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", bindingId)),
          ),
        )
        .transformRetrieve(([binding]) => {
          if (!binding) {
            return null;
          }

          const resolved = toExternalIdentityBinding(binding);
          return resolved.status === "active" ? resolved : null;
        })
        .build();
    },

    bindExternalIdentity(args: BindExternalIdentityInput) {
      const input = bindExternalIdentityInputSchema.parse(args);
      const bindingId = buildExternalIdentityBindingId(input.identity);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("external_identity_binding", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", bindingId)),
            )
            .findFirst("external_identity_claim_consumption", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.verifiedByClaimId)),
            ),
        )
        .mutate(({ uow, retrieveResult: [existingBinding, consumedClaim] }) => {
          const consumeClaim = (acceptedBindingVersion: number) => {
            uow.create(
              "external_identity_claim_consumption",
              {
                id: input.verifiedByClaimId,
                bindingId,
                userId: input.userId,
                acceptedBindingVersion,
                acceptedAt: uow.now(),
              },
              { retryOnUniqueConflict: () => true },
            );
          };

          if (consumedClaim) {
            if (consumedClaim.bindingId !== bindingId) {
              throw new ExternalIdentityBindingConflictError(
                "verified-claim-used-for-another-binding",
              );
            }
            if (consumedClaim.userId !== input.userId) {
              throw new ExternalIdentityBindingConflictError(
                "verified-claim-used-for-another-user",
              );
            }

            if (!existingBinding) {
              return {
                status: "superseded",
                outcome: "unchanged",
                bindingId,
                userId: consumedClaim.userId,
                version: consumedClaim.acceptedBindingVersion,
              } satisfies BindExternalIdentityResult;
            }

            if (existingBinding.revokedAt !== null) {
              return {
                status: "revoked",
                outcome: "unchanged",
                bindingId,
                userId: consumedClaim.userId,
                version: existingBinding.id.version,
              } satisfies BindExternalIdentityResult;
            }

            if (
              existingBinding.userId !== consumedClaim.userId ||
              existingBinding.id.version !== consumedClaim.acceptedBindingVersion
            ) {
              return {
                status: "superseded",
                outcome: "unchanged",
                bindingId,
                userId: consumedClaim.userId,
                version: existingBinding.id.version,
              } satisfies BindExternalIdentityResult;
            }

            return {
              status: "active",
              outcome: "unchanged",
              bindingId,
              userId: consumedClaim.userId,
              version: existingBinding.id.version,
            } satisfies BindExternalIdentityResult;
          }

          if (!existingBinding) {
            const now = uow.now();
            const createdBindingId = uow.create(
              "external_identity_binding",
              {
                id: bindingId,
                source: input.identity.source,
                externalType: input.identity.type,
                externalId: input.identity.id,
                userId: input.userId,
                verifiedByClaimId: input.verifiedByClaimId,
                boundAt: now,
                revokedAt: null,
              },
              { retryOnUniqueConflict: () => true },
            );
            consumeClaim(createdBindingId.version);

            return {
              status: "active",
              outcome: "created",
              bindingId,
              userId: input.userId,
              version: createdBindingId.version,
            } satisfies BindExternalIdentityResult;
          }

          if (existingBinding.verifiedByClaimId === input.verifiedByClaimId) {
            consumeClaim(existingBinding.id.version);
            return {
              status: existingBinding.revokedAt === null ? "active" : "revoked",
              outcome: "unchanged",
              bindingId,
              userId: existingBinding.userId,
              version: existingBinding.id.version,
            } satisfies BindExternalIdentityResult;
          }

          if (existingBinding.revokedAt === null) {
            if (existingBinding.userId !== input.userId) {
              throw new ExternalIdentityBindingConflictError("identity-bound-to-another-user");
            }

            consumeClaim(existingBinding.id.version);
            return {
              status: "active",
              outcome: "unchanged",
              bindingId,
              userId: existingBinding.userId,
              version: existingBinding.id.version,
            } satisfies BindExternalIdentityResult;
          }

          const reactivatedVersion = existingBinding.id.version + 1;
          uow.update("external_identity_binding", existingBinding.id, (b) =>
            b
              .set({
                userId: input.userId,
                verifiedByClaimId: input.verifiedByClaimId,
                boundAt: uow.now(),
                revokedAt: null,
              })
              .check(),
          );
          consumeClaim(reactivatedVersion);

          return {
            status: "active",
            outcome: "reactivated",
            bindingId,
            userId: input.userId,
            version: reactivatedVersion,
          } satisfies BindExternalIdentityResult;
        })
        .build();
    },

    revokeExternalIdentity(args: RevokeExternalIdentityInput) {
      const input = revokeExternalIdentityInputSchema.parse(args);
      const bindingId = buildExternalIdentityBindingId(input.identity);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("external_identity_binding", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", bindingId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existingBinding] }) => {
          if (!existingBinding) {
            return { status: "not-found" } satisfies RevokeExternalIdentityResult;
          }

          if (existingBinding.userId !== input.expectedUserId) {
            throw new ExternalIdentityBindingConflictError("binding-owner-changed");
          }

          if (existingBinding.revokedAt !== null) {
            return {
              status: "revoked",
              outcome: "unchanged",
              bindingId,
              userId: existingBinding.userId,
              version: existingBinding.id.version,
            } satisfies RevokeExternalIdentityResult;
          }

          if (existingBinding.id.version !== input.expectedVersion) {
            throw new ExternalIdentityBindingConflictError("binding-version-changed");
          }

          uow.update("external_identity_binding", existingBinding.id, (b) =>
            b.set({ revokedAt: uow.now() }).check(),
          );

          return {
            status: "revoked",
            outcome: "revoked",
            bindingId,
            userId: existingBinding.userId,
            version: existingBinding.id.version + 1,
          } satisfies RevokeExternalIdentityResult;
        })
        .build();
    },
  });
