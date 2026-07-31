import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";

import { automationEntityRefsEqual, type AutomationActors } from "../actors";
import type { AutomationEvent } from "../contracts";

/**
 * Preserves event provenance while naming the automation runtime that executes the event.
 *
 * Until automation definitions have stable actor identities, the event identity keeps executions
 * distinct. An automation becomes the principal only when a non-system event has no principal.
 * Otherwise it is a delegate whose current capability grants must authorize every kernel action.
 */
export const createAutomationRuntimeExecution = (
  event: AutomationEvent,
): BackofficeExecutionContext => {
  const runtimeIdentity = {
    scope: "internal" as const,
    type: "automation" as const,
    id: `automation:${event.id}`,
  };

  const systemInitiated =
    event.actors.initiator.scope === "internal" && event.actors.initiator.type === "system";
  if (!event.actors.principal && !systemInitiated) {
    const principal = {
      ...runtimeIdentity,
      role: "principal" as const,
    } satisfies NonNullable<AutomationActors["principal"]>;

    return {
      scope: event.scope,
      actors: {
        ...event.actors,
        principal,
      },
    };
  }

  const runtimeAlreadyNamed = [
    ...(event.actors.principal ? [event.actors.principal] : []),
    ...event.actors.delegation,
  ].some((actor) => automationEntityRefsEqual(actor, runtimeIdentity));
  const delegation = runtimeAlreadyNamed
    ? event.actors.delegation
    : [
        ...event.actors.delegation,
        {
          ...runtimeIdentity,
          role: "delegate" as const,
        } satisfies AutomationActors["delegation"][number],
      ];

  return {
    scope: event.scope,
    actors: {
      ...event.actors,
      delegation,
    },
  };
};
