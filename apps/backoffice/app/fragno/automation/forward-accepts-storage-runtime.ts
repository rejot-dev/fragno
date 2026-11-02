import {
  type AutomationEventMatcher,
  type AutomationForwardAccept,
  type AutomationForwardAcceptCreateInput,
  automationForwardAcceptCreateInputSchema,
  type AutomationForwardAcceptUpdateInput,
  automationForwardAcceptUpdateInputSchema,
  type AutomationForwardSenders,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { forwardSendersFitScope } from "./forward-accepts";
import { automationFragmentSchema } from "./schema";

type ForwardAcceptServiceContext = DatabaseServiceContext<Record<string, never>>;

type ForwardAcceptRow = {
  id: { externalId: string };
  name: string;
  enabled: boolean;
  senders: AutomationForwardSenders;
  matcher: AutomationEventMatcher | null;
  description: string | null;
};

/** Writing an accept refuses `members` outside an organization's scopes. */
type ForwardAcceptWriteOutcome<TReason extends string> =
  | { ok: true; accept: AutomationForwardAccept }
  | { ok: false; reason: TReason | "members-outside-organization" };

export type ForwardAcceptCreateOutcome = ForwardAcceptWriteOutcome<"exists">;
export type ForwardAcceptUpdateOutcome = ForwardAcceptWriteOutcome<"not-found">;

export function forwardAcceptFromRow(row: ForwardAcceptRow): AutomationForwardAccept {
  return {
    id: row.id.externalId,
    name: row.name,
    enabled: row.enabled,
    from: row.senders,
    matcher: row.matcher,
    description: row.description,
  };
}

export const createForwardAcceptServices = (
  defineService: <TService>(service: TService & ThisType<ForwardAcceptServiceContext>) => TService,
  { ownerScope }: { ownerScope: BackofficeContextScope },
) =>
  defineService({
    listForwardAccepts() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("automation_forward_accept", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) => rows.map(forwardAcceptFromRow))
        .build();
    },

    createForwardAccept(input: AutomationForwardAcceptCreateInput) {
      const accept: AutomationForwardAccept = automationForwardAcceptCreateInputSchema.parse(input);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_forward_accept", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", accept.id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }): ForwardAcceptCreateOutcome => {
          if (existing) {
            return { ok: false, reason: "exists" };
          }
          if (!forwardSendersFitScope(accept.from, ownerScope)) {
            return { ok: false, reason: "members-outside-organization" };
          }
          const { from: senders, ...columns } = accept;
          uow.create("automation_forward_accept", {
            ...columns,
            senders,
            createdAt: uow.now(),
            updatedAt: uow.now(),
          });
          return { ok: true, accept };
        })
        .build();
    },

    updateForwardAccept(input: AutomationForwardAcceptUpdateInput) {
      const { id, ...patch } = automationForwardAcceptUpdateInputSchema.parse(input);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_forward_accept", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }): ForwardAcceptUpdateOutcome => {
          if (!existing) {
            return { ok: false, reason: "not-found" };
          }
          const current = forwardAcceptFromRow(existing);
          const accept: AutomationForwardAccept = {
            id,
            name: patch.name ?? current.name,
            enabled: patch.enabled ?? current.enabled,
            from: patch.from ?? current.from,
            matcher: patch.matcher === undefined ? current.matcher : patch.matcher,
            description: patch.description === undefined ? current.description : patch.description,
          };
          if (!forwardSendersFitScope(accept.from, ownerScope)) {
            return { ok: false, reason: "members-outside-organization" };
          }
          const { id: _id, from: senders, ...columns } = accept;
          uow.update("automation_forward_accept", existing.id, (b) =>
            b.set({ ...columns, senders, updatedAt: uow.now() }).check(),
          );
          return { ok: true, accept };
        })
        .build();
    },

    /** Returns whether the accept existed. */
    deleteForwardAccept({ id }: { id: string }) {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_forward_accept", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return false;
          }
          uow.delete("automation_forward_accept", existing.id);
          return true;
        })
        .build();
    },
  });
