import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { Context } from "@earendil-works/chord";
import {
  ROOT_CONVERSATION_ID,
  type CommitPublication,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";

import type { AutomationsObject } from "@/backoffice-runtime/object-registry";
import {
  PI_AUTOMATION_EVENT_TURN_COMPLETED,
  PI_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/pi";

import type { BackofficeAgentContext } from "./backoffice-agent-context";
import {
  forgetReportedPiAgentTurn,
  readSettledPiAgentTurns,
  type SettledPiAgentTurn,
} from "./pi-agent-turns";

function piAgentTurnCompletedEvent(
  config: PiAgentConfig,
  agent: BackofficeAgentContext,
  { requestId, turn }: SettledPiAgentTurn,
  answerEntryId: number,
  occurredAt: Date,
): AutomationEvent {
  const { scope } = config;
  const organization = backofficeScopeOrganization(scope);
  return {
    // A request ID settles once per conversation, so redelivery records one event.
    id: `pi:${config.agentName}:${requestId}`,
    scope,
    // Automations started by this event inherit the turn's ceiling, never a wider one.
    scopeRestriction: turn.scopeRestriction,
    source: PI_AUTOMATION_SOURCE,
    eventType: PI_AUTOMATION_EVENT_TURN_COMPLETED,
    payload: { answerEntryId },
    occurredAt: occurredAt.toISOString(),
    actors: agent.turn(turn).execution.actors,
    subject: {
      ...(organization ? { orgId: organization.orgId } : {}),
      ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
      agentName: config.agentName,
      requestId,
    },
  };
}

function settlesRootSubmission(publication: CommitPublication) {
  return publication.changes.some(
    (change) =>
      change.type === "submission" &&
      change.value.conversationId === ROOT_CONVERSATION_ID &&
      (change.value.status === "done" || change.value.status === "unanswered"),
  );
}

/**
 * Records each answered turn as a `pi` Automations event, then forgets every settled turn. Pi settles
 * submissions in commits Backoffice cannot join, so a report follows each commit that settles a
 * turn. That report dies with the object, so callers that must not lose one, like the agent
 * alarm, call the returned function again.
 */
export function startReportingPiAgentTurns(input: {
  config: PiAgentConfig;
  agent: BackofficeAgentContext;
  harness: Harness;
  storage: Storage;
  /** Null when the runtime has no Automations, which leaves nowhere to record turn history. */
  automations: Pick<AutomationsObject, "ingestEvent"> | null;
  nowEpochMs: () => number;
  report: (error: unknown) => void;
}): (context: Context) => Promise<void> {
  const { config, agent, harness, storage, automations } = input;
  let reporting = Promise.resolve();

  async function reportSettledTurn(settled: SettledPiAgentTurn, context: Context) {
    // Unanswered turns, such as aborted or withdrawn prompts, are forgotten without an event.
    const { submission } = settled;
    if (submission.type === "input" && submission.status === "done") {
      // The settling commit carries no time; its listener reports right after it.
      await automations?.ingestEvent(
        piAgentTurnCompletedEvent(
          config,
          agent,
          settled,
          submission.answer,
          new Date(input.nowEpochMs()),
        ),
        { propagationContext: null },
      );
    }
    await forgetReportedPiAgentTurn(harness, settled.requestId, context);
  }

  async function reportSettledTurns(context: Context) {
    // A turn that cannot be reported stays pending without holding back the turns after it.
    const failures: unknown[] = [];
    for (const settled of await readSettledPiAgentTurns(harness, storage, context)) {
      try {
        await reportSettledTurn(settled, context);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Some settled Pi turns could not be reported.");
    }
  }

  // One report at a time, so overlapping triggers do not ingest and forget the same turn at once.
  function report(context: Context) {
    const reported = reporting.then(async () => {
      await reportSettledTurns(context);
    });
    reporting = reported.catch(() => undefined);
    return reported;
  }

  harness.subscribeCommits((publication) => {
    if (settlesRootSubmission(publication)) {
      report(BACKGROUND_CONTEXT).catch(input.report);
    }
  });
  return report;
}
