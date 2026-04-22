import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { AuthPrincipal } from "../auth/types";
import { authSchema } from "../schema";
import { toExternalId } from "./utils";

type AuthServiceContext = DatabaseServiceContext<{}>;

const resolveSessionCredentialId = (principal: AuthPrincipal) =>
  principal.auth.credentialKind === "session" ? principal.auth.credentialId : null;

export function createActiveOrganizationServices() {
  const setActiveOrganization = function (
    this: AuthServiceContext,
    credentialToken: string,
    organizationId: string,
  ) {
    return this.serviceTx(authSchema)
      .retrieve((uow) =>
        uow
          .findFirst("session", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", credentialToken)),
          )
          .find("organizationMember", (b) =>
            b.whereIndex("idx_org_member_org", (eb) => eb("organizationId", "=", organizationId)),
          ),
      )
      .mutate(({ uow, retrieveResult: [session, members] }) => {
        if (!session) {
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

        uow.update("session", session.id, (b) =>
          b.set({ activeOrganizationId: organizationId }).check(),
        );

        return { ok: true as const };
      })
      .build();
  };

  const getActiveOrganization = function (this: AuthServiceContext, credentialToken: string) {
    return this.serviceTx(authSchema)
      .retrieve((uow) =>
        uow.findFirst("session", (b) =>
          b
            .whereIndex("primary", (eb) => eb("id", "=", credentialToken))
            .joinOne("sessionActiveOrganization", "organization", (organization) =>
              organization.onIndex("primary", (eb) =>
                eb("id", "=", eb.parent("activeOrganizationId")),
              ),
            ),
        ),
      )
      .transformRetrieve(([session]) => {
        if (!session || !session.sessionActiveOrganization) {
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
