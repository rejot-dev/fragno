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
          uow.findFirst("session", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", sessionId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [session] }) => {
          if (!session) {
            return { ok: false as const, code: "session_not_found" as const };
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
