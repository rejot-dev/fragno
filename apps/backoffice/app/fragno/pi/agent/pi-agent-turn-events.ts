import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";

import type { Context } from "@earendil-works/chord";
import {
  ROOT_CONVERSATION_ID,
  type CommitPublication,
  type Harness,
  type SettledSubmissionRecord,
  type Storage,
} from "@earendil-works/pi-durable";

import type { AutomationsCommands, PiManagerCommands } from "@/backoffice-runtime/object-registry";
import {
  PI_AUTOMATION_SOURCE,
  PI_TURN_AUTOMATION_EVENTS,
  piAgentEventSubject,
} from "@/fragno/backoffice-capabilities/capabilities/pi";

import type { BackofficeAgentContext } from "./backoffice-agent-context";
import {
  forgetReportedPiAgentTurn,
  forgetReportedQueuedPiCompaction,
  readReportablePiAgentTurns,
  readSettledQueuedPiCompactions,
  type ReportablePiAgentTurn,
} from "./pi-agent-turns";

/** Pi settles a turn the agent's stop cut off as unanswered with this reason. */
const ABORTED_SUBMISSION_REASON = "aborted";

type PiTurnEvent = {
  /** Distinguishes the turn's start from its end, which share the request ID. */
  phase: "started" | "ended";
  eventType: string;
  payload: Record<string, unknown>;
};

const STARTED_TURN_EVENT: PiTurnEvent = {
  phase: "started",
  eventType: PI_TURN_AUTOMATION_EVENTS.started.eventType,
  payload: {},
};

/**
 * Names the answer's entry without its text: event readers need only `events.read`, and the answer
 * stays behind `pi.read`, as `pi.getPrompt` reads it.
 */
function completedTurnEvent(answerEntryId: number): PiTurnEvent {
  return {
    phase: "ended",
    eventType: PI_TURN_AUTOMATION_EVENTS.completed.eventType,
    payload: { answerEntryId },
  };
}

/** The event a settled input records: answered, cut off by a stop, or failed for another reason. */
function settledTurnEventOf(submission: SettledSubmissionRecord): PiTurnEvent | null {
  if (submission.type !== "input") {
    return null;
  }
  if (submission.status === "done") {
    return completedTurnEvent(submission.answer);
  }
  return submission.reason === ABORTED_SUBMISSION_REASON
    ? { phase: "ended", eventType: PI_TURN_AUTOMATION_EVENTS.aborted.eventType, payload: {} }
    : {
        phase: "ended",
        eventType: PI_TURN_AUTOMATION_EVENTS.failed.eventType,
        payload: { reason: submission.reason },
      };
}

function piAgentTurnEvent(
  config: PiAgentConfig,
  agent: BackofficeAgentContext,
  { requestId, turn }: Pick<ReportablePiAgentTurn, "requestId" | "turn">,
  { phase, eventType, payload }: PiTurnEvent,
  occurredAt: Date,
): AutomationEvent {
  const { scope } = config;
  return {
    // A request ID starts and settles once per conversation, so redelivery records one event.
    // Callers choose request IDs, so the phase comes first: no request ID can forge another's.
    id: `pi:${config.agentName}:${phase}:${requestId}`,
    scope,
    // Automations started by this event inherit the turn's ceiling, never a wider one.
    scopeRestriction: turn.scopeRestriction,
    source: PI_AUTOMATION_SOURCE,
    eventType,
    payload,
    occurredAt: occurredAt.toISOString(),
    actors: agent.turn(turn).execution.actors,
    subject: { ...piAgentEventSubject(scope, config.agentName), requestId },
    causation: { kind: "origin" },
  };
}

/** Records that the turn answered, as a real agent does; for fakes that answer without Pi. */
export function piAgentTurnCompletedEvent(
  config: PiAgentConfig,
  agent: BackofficeAgentContext,
  turn: Pick<ReportablePiAgentTurn, "requestId" | "turn">,
  answerEntryId: number,
  occurredAt: Date,
): AutomationEvent {
  return piAgentTurnEvent(config, agent, turn, completedTurnEvent(answerEntryId), occurredAt);
}

// The root's turns and its subagents' are reported alike, so a change to any conversation counts.
function changesSubmission(publication: CommitPublication) {
  return publication.changes.some(
    (change) =>
      change.type === "submission" &&
      (change.value.status === "placed" ||
        change.value.status === "done" ||
        change.value.status === "unanswered"),
  );
}

/**
 * Records each turn's start and end as `pi` Automations events and tells the agent's manager every
 * turn that settled, then forgets it. Pi starts and settles submissions in commits Backoffice
 * cannot join, so a report follows each commit that does. A turn's start is recorded before its
 * end, also when the turn settles before its start was reported, and recording it again records
 * nothing. Compactions the queue dispatched are reported to the manager once they end. A report
 * dies with the object, so callers that must not lose one, like the agent alarm, call the returned
 * function again.
 */
export function startReportingPiAgentTurns(input: {
  config: PiAgentConfig;
  agent: BackofficeAgentContext;
  harness: Harness;
  storage: Storage;
  /** Null when the runtime has no Automations, which leaves nowhere to record turn history. */
  automations: Pick<AutomationsCommands, "ingestEvent"> | null;
  manager: PiManagerCommands;
  /** Whether the root's context outgrew its compaction threshold. */
  compactionDue: (context: Context) => Promise<boolean>;
  nowEpochMs: () => number;
  report: (error: unknown) => void;
}): (context: Context) => Promise<void> {
  const { config, agent, harness, storage, automations, manager } = input;
  let reporting = Promise.resolve();

  // The commits carry no time; their listener reports right after them.
  function turnEvent(reportable: ReportablePiAgentTurn, event: PiTurnEvent) {
    return piAgentTurnEvent(config, agent, reportable, event, new Date(input.nowEpochMs()));
  }

  async function recordTurnEvents(events: readonly AutomationEvent[]) {
    for (const event of events) {
      await automations?.ingestEvent(event, { propagationContext: null });
    }
  }

  async function reportTurn(reportable: ReportablePiAgentTurn, context: Context) {
    const { requestId, started, settlement } = reportable;
    const startedEvent = started ? turnEvent(reportable, STARTED_TURN_EVENT) : null;
    if (!settlement) {
      await recordTurnEvents(startedEvent ? [startedEvent] : []);
      return;
    }
    const endedTurn = settledTurnEventOf(settlement);
    const ended = endedTurn ? turnEvent(reportable, endedTurn) : null;
    // Subagents answer once, so only the root's context is compacted between turns.
    const compact =
      reportable.conversationId === ROOT_CONVERSATION_ID && (await input.compactionDue(context));
    // Both reports are idempotent, and an unrecordable event must not stop the agent's queue.
    const [recorded, advanced] = await Promise.allSettled([
      recordTurnEvents([...(startedEvent ? [startedEvent] : []), ...(ended ? [ended] : [])]),
      manager.reportSettledTurn({ agentName: config.agentName, requestId, ended, compact }),
    ]);
    for (const report of [recorded, advanced]) {
      if (report.status === "rejected") {
        throw report.reason;
      }
    }
    await forgetReportedPiAgentTurn(harness, requestId, context);
  }

  async function reportTurns(context: Context) {
    // A turn that cannot be reported stays pending without holding back the turns after it.
    const failures: unknown[] = [];
    for (const reportable of await readReportablePiAgentTurns(harness, storage, context)) {
      try {
        await reportTurn(reportable, context);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const requestId of await readSettledQueuedPiCompactions(harness, context)) {
      try {
        await manager.reportSettledTurn({
          agentName: config.agentName,
          requestId,
          ended: null,
          compact: false,
        });
        await forgetReportedQueuedPiCompaction(harness, requestId, context);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Some Pi turns could not be reported.");
    }
  }

  // One report at a time, so overlapping triggers do not ingest and forget the same turn at once.
  function report(context: Context) {
    const reported = reporting.then(async () => {
      await reportTurns(context);
    });
    reporting = reported.catch(() => undefined);
    return reported;
  }

  harness.subscribeCommits((publication) => {
    if (changesSubmission(publication)) {
      report(BACKGROUND_CONTEXT).catch(input.report);
    }
  });
  return report;
}
