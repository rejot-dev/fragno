import type { HookContext } from "@fragno-dev/db";

import type {
  AutomationCreateIdentityClaimInput,
  AutomationCreateIdentityClaimResult,
  AutomationEvent,
} from "./contracts";
import type { AutomationBashRuntime, AutomationEmitEventResult } from "./engine/bash";
import { automationFragmentSchema } from "./schema";

type AutomationHookContextLike = Pick<HookContext, "idempotencyKey" | "handlerTx">;

type CreateAutomationBashRuntimeOptions = {
  hookContext: AutomationHookContextLike;
  event: AutomationEvent;
  createIdentityClaim?: (
    input: AutomationCreateIdentityClaimInput,
  ) => Promise<AutomationCreateIdentityClaimResult>;
  buildIngestResult: (event: AutomationEvent) => AutomationEmitEventResult;
};

export const createAutomationBashRuntime = ({
  hookContext,
  event,
  createIdentityClaim,
  buildIngestResult,
}: CreateAutomationBashRuntimeOptions): AutomationBashRuntime => ({
  lookupBinding: async ({ source, externalActorId }) => {
    return await hookContext
      .handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(automationFragmentSchema).findFirst("identity_binding", (b) =>
          b.whereIndex("idx_identity_binding_source_actor", (eb) =>
            eb.and(eb("source", "=", source), eb("externalActorId", "=", externalActorId)),
          ),
        ),
      )
      .transformRetrieve(([binding]) => (binding?.status === "linked" ? binding : null))
      .execute();
  },
  bindActor: async ({ source, externalActorId, userId }) => {
    const existing = await hookContext
      .handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(automationFragmentSchema).findFirst("identity_binding", (b) =>
          b.whereIndex("idx_identity_binding_source_actor", (eb) =>
            eb.and(eb("source", "=", source), eb("externalActorId", "=", externalActorId)),
          ),
        ),
      )
      .transformRetrieve((retrieveResult) => retrieveResult[0] ?? null)
      .execute();

    return await hookContext
      .handlerTx()
      .mutate(({ forSchema }) => {
        const table = forSchema(automationFragmentSchema);
        const now = table.now();

        if (existing) {
          table.update("identity_binding", existing.id, (b) =>
            b
              .set({
                source,
                externalActorId,
                userId,
                status: "linked",
                linkedAt: now,
                updatedAt: now,
              })
              .check(),
          );

          return {
            ...existing,
            source,
            externalActorId,
            userId,
            status: "linked" as const,
            linkedAt: now,
            updatedAt: now,
          };
        }

        const createdId = table.create("identity_binding", {
          source,
          externalActorId,
          userId,
          status: "linked",
          linkedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        return {
          id: createdId.valueOf(),
          source,
          externalActorId,
          userId,
          status: "linked" as const,
          linkedAt: now,
          createdAt: now,
          updatedAt: now,
        };
      })
      .transform(({ mutateResult }) => mutateResult)
      .execute();
  },
  createClaim: async ({ source, externalActorId, ttlMinutes }) => {
    if (!createIdentityClaim) {
      throw new Error("identity.create-claim is not configured");
    }

    const issued = await createIdentityClaim({
      orgId: event.orgId,
      source,
      externalActorId,
      ttlMinutes,
      event: { ...event, orgId: event.orgId },
      idempotencyKey: hookContext.idempotencyKey,
    });

    return issued;
  },
  emitEvent: async ({ eventType, source, externalActorId, actorType, subjectUserId, payload }) => {
    const nextEvent: AutomationEvent = {
      id: `${event.id}:${eventType}:${crypto.randomUUID()}`,
      orgId: event.orgId,
      source: source ?? event.source,
      eventType,
      occurredAt: new Date().toISOString(),
      payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {},
      actor: externalActorId
        ? {
            type: actorType ?? event.actor?.type ?? "external",
            externalId: externalActorId,
          }
        : null,
      subject: subjectUserId ? { userId: subjectUserId } : null,
    };

    return await hookContext
      .handlerTx()
      .mutate(({ forSchema }) => {
        forSchema(automationFragmentSchema).triggerHook("internalIngestEvent", nextEvent, {
          id: nextEvent.id,
        });
      })
      .transform(() => buildIngestResult(nextEvent))
      .execute();
  },
});
