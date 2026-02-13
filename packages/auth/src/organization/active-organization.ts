import type { DatabaseServiceContext } from "@fragno-dev/db";
import { authSchema } from "../schema";
import { toExternalId } from "./utils";

type AuthServiceContext = DatabaseServiceContext<{}>;

export function createActiveOrganizationServices() {
  return {
    setActiveOrganization: function (
      this: AuthServiceContext,
      sessionId: string,
      organizationId: string,
    ) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow
            .findFirst("session", (b) => b.whereIndex("primary", (eb) => eb("id", "=", sessionId)))
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
    },

    getActiveOrganization: function (this: AuthServiceContext, sessionId: string) {
      return this.serviceTx(authSchema)
        .retrieve((uow) =>
          uow.findFirst("session", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", sessionId))
              .join((j) => j.sessionActiveOrganization()),
          ),
        )
        .transformRetrieve(([session]) => {
          if (!session || !session.sessionActiveOrganization) {
            return { organizationId: null };
          }

          return { organizationId: toExternalId(session.sessionActiveOrganization.id) };
        })
        .build();
    },
  };
}
