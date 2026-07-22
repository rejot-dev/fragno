import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AuthPrincipal } from "../auth/types";
import type { AuthEmailVerificationConfig } from "../email-verification-policy";
import type { AuthHooksMap } from "../hooks";
import { authSchema } from "../schema";
import {
  sessionCredentialOwnerSelect,
  validateSessionCredentialOwner,
} from "../session/session-credential-validator";
import { toExternalId } from "./utils";

type AuthServiceContext = DatabaseServiceContext<AuthHooksMap>;

const resolveSessionCredentialId = (principal: AuthPrincipal) =>
  principal.auth.credentialKind === "session" ? principal.auth.credentialId : null;

export function createActiveOrganizationServices(
  emailVerification: AuthEmailVerificationConfig | undefined,
) {
  const setActiveOrganization = function (
    this: AuthServiceContext,
    credentialToken: string,
    organizationId: string,
  ) {
    return this.serviceTx(authSchema)
      .retrieve((uow) =>
        uow
          .findFirst("session", (builder) =>
            builder
              .whereIndex("idx_session_id_expiresAt", (expression) =>
                expression.and(
                  expression("id", "=", credentialToken),
                  expression("expiresAt", ">", expression.now()),
                ),
              )
              .joinOne("sessionOwner", "user", (owner) =>
                owner
                  .onIndex("primary", (expression) =>
                    expression("id", "=", expression.parent("userId")),
                  )
                  .select(sessionCredentialOwnerSelect),
              ),
          )
          .findFirst("session", (builder) =>
            builder.whereIndex("idx_session_id_expiresAt", (expression) =>
              expression.and(
                expression("id", "=", credentialToken),
                expression("expiresAt", "<=", expression.now()),
              ),
            ),
          )
          .find("organizationMember", (builder) =>
            builder.whereIndex("idx_org_member_org", (expression) =>
              expression("organizationId", "=", organizationId),
            ),
          ),
      )
      .mutate(({ uow, retrieveResult: [session, expiredSession, members] }) => {
        if (expiredSession) {
          uow.delete("session", expiredSession.id, (builder) => builder.check());
        }

        const validation = validateSessionCredentialOwner(session?.sessionOwner, emailVerification);
        if (!validation.ok || !session) {
          return { ok: false as const, code: "session_not_found" as const };
        }

        const normalizeId = (value: unknown) => {
          if (value && typeof value === "object") {
            if ("internalId" in value) {
              return (value as { internalId?: unknown }).internalId;
            }
            if ("externalId" in value) {
              return (value as { externalId?: unknown }).externalId;
            }
          }
          return value;
        };
        const sessionUserId = normalizeId(session.userId);
        const isMember = members.some((member) => normalizeId(member.userId) === sessionUserId);
        if (!isMember) {
          return { ok: false as const, code: "membership_not_found" as const };
        }

        uow.update("session", session.id, (builder) =>
          builder.set({ activeOrganizationId: organizationId }).check(),
        );

        return { ok: true as const };
      })
      .build();
  };

  const getActiveOrganization = function (this: AuthServiceContext, credentialToken: string) {
    return this.serviceTx(authSchema)
      .retrieve((uow) =>
        uow
          .findFirst("session", (builder) =>
            builder
              .whereIndex("idx_session_id_expiresAt", (expression) =>
                expression.and(
                  expression("id", "=", credentialToken),
                  expression("expiresAt", ">", expression.now()),
                ),
              )
              .joinOne("sessionOwner", "user", (owner) =>
                owner
                  .onIndex("primary", (expression) =>
                    expression("id", "=", expression.parent("userId")),
                  )
                  .select(sessionCredentialOwnerSelect),
              )
              .joinOne("sessionActiveOrganization", "organization", (organization) =>
                organization.onIndex("primary", (expression) =>
                  expression("id", "=", expression.parent("activeOrganizationId")),
                ),
              ),
          )
          .findFirst("session", (builder) =>
            builder.whereIndex("idx_session_id_expiresAt", (expression) =>
              expression.and(
                expression("id", "=", credentialToken),
                expression("expiresAt", "<=", expression.now()),
              ),
            ),
          ),
      )
      .mutate(({ uow, retrieveResult: [session, expiredSession] }) => {
        if (expiredSession) {
          uow.delete("session", expiredSession.id, (builder) => builder.check());
        }

        const validation = validateSessionCredentialOwner(session?.sessionOwner, emailVerification);
        if (!validation.ok || !session?.sessionActiveOrganization) {
          return { organizationId: null };
        }

        return { organizationId: toExternalId(session.sessionActiveOrganization.id) };
      })
      .build();
  };

  return {
    /**
     * Set the active organization for a resolved principal.
     */
    setActiveOrganizationForPrincipal: function (
      this: AuthServiceContext,
      params: { principal: AuthPrincipal; organizationId: string },
    ) {
      const credentialToken = resolveSessionCredentialId(params.principal);
      if (!credentialToken) {
        return this.serviceTx(authSchema)
          .mutate(() => ({ ok: false as const, code: "session_not_found" as const }))
          .build();
      }

      return setActiveOrganization.call(this, credentialToken, params.organizationId);
    },

    /**
     * Get the active organization id for a resolved principal.
     */
    getActiveOrganizationForPrincipal: function (
      this: AuthServiceContext,
      params: { principal: AuthPrincipal },
    ) {
      const credentialToken = resolveSessionCredentialId(params.principal);
      if (!credentialToken) {
        return this.serviceTx(authSchema)
          .mutate(() => ({ organizationId: null }))
          .build();
      }

      return getActiveOrganization.call(this, credentialToken);
    },
  };
}
