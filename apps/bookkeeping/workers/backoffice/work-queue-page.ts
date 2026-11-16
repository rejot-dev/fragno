import { BOOKKEEPER_AGENT_NAME } from "./connection";
import { REQUEST_EVENT_TYPE } from "./request-events";

/**
 * The source of the firm's work queue, a Backoffice page the bookkeeping agent's package installs in
 * its project: what Bookkeeping asked the agent, read from the state of Bookkeeping's request events
 * from `eventSource`, and how far the agent got, read from its turn events. Backoffice runs the
 * page's SQL in the browser, over the project's relations as the browser keeps them.
 */
export function workQueuePage(eventSource: string): string {
  return `// What Bookkeeping asked the firm's bookkeeping agent, and how far the agent got. Bookkeeping fires
// a proposal.changed event each time a request about a document or bank transaction changes, keyed
// by its subject, so event_state holds each subject's latest request; the agent's turn events name
// the request they work on.
export default page.define({ title: "Bookkeeping work queue" }, ({ sql, now }) => {
  const day = now.minus("24 hours");

  // Each request's latest turn event, from being queued to how its turn ended.
  const turns = sql\`
    SELECT subject ->> '$.requestId' AS requestId, eventType, occurredAt,
      row_number() OVER (
        PARTITION BY subject ->> '$.requestId' ORDER BY occurredAt DESC, position DESC
      ) AS recency
    FROM events
    WHERE source = 'pi' AND subject ->> '$.agentName' = '${BOOKKEEPER_AGENT_NAME}'
      AND eventType IN (
        'queue.added', 'queue.dispatched', 'queue.dropped',
        'turn.started', 'turn.completed', 'turn.failed', 'turn.aborted'
      )
  \`;

  // Each request names the client and administration whose books it is in, the administration
  // once when it has the client's name. Requests Bookkeeping asked before it named them have
  // neither title nor names.
  const requests = sql\`
    WITH request AS (
      SELECT key, payload, occurredAt,
        CASE WHEN key LIKE 'document:%' THEN 'Document' ELSE 'Bank transaction' END AS kind,
        payload ->> '$.client' AS client, payload ->> '$.administration' AS administration
      FROM event_state
      WHERE source = '${eventSource}' AND eventType = '${REQUEST_EVENT_TYPE}'
    )
    SELECT key, payload ->> '$.requestId' AS requestId, payload ->> '$.status' AS status,
      coalesce(payload ->> '$.title', 'Untitled request') AS title,
      CASE
        WHEN client IS NULL THEN kind
        WHEN client = administration THEN client || ' · ' || kind
        ELSE client || ' · ' || administration || ' · ' || kind
      END AS detail,
      occurredAt AS at
    FROM request
  \`;

  // How far the agent got with each open request. A turn that ended a minute ago with its request
  // still open ended without an answer; within the minute, Bookkeeping may still be telling the
  // firm of the answer.
  const staged = sql\`
    WITH turn AS (SELECT * FROM (\${turns}) WHERE recency = 1)
    SELECT request.title, request.detail, request.at,
      CASE
        WHEN turn.eventType IS NULL THEN 'waiting'
        WHEN turn.eventType IN ('queue.added', 'queue.dispatched') THEN 'queued'
        WHEN turn.eventType = 'turn.started' THEN 'working'
        WHEN turn.eventType = 'turn.completed' AND turn.occurredAt >= \${now.minus("1 minute")}
          THEN 'working'
        WHEN turn.eventType = 'turn.completed' THEN 'unanswered'
        ELSE 'failed'
      END AS stage
    FROM (\${requests}) request
    LEFT JOIN turn ON turn.requestId = request.requestId
    WHERE request.status = 'requested'
  \`;

  // The list shows the first of them, problems first; the counts count them all.
  const open = sql\`
    SELECT title, detail, at, stage,
      CASE stage
        WHEN 'waiting' THEN 'Not started'
        WHEN 'queued' THEN 'Queued'
        WHEN 'working' THEN 'Working on it'
        WHEN 'unanswered' THEN 'Ended without an answer'
        ELSE 'Failed'
      END AS label,
      CASE stage WHEN 'working' THEN 'live' WHEN 'unanswered' THEN 'failed'
        WHEN 'failed' THEN 'failed' ELSE 'waiting' END AS tone,
      CASE stage WHEN 'working' THEN 'activity' WHEN 'unanswered' THEN 'alert-triangle'
        WHEN 'failed' THEN 'x-circle' ELSE 'clock' END AS icon
    FROM (\${staged})
    ORDER BY stage IN ('unanswered', 'failed') DESC, stage = 'working' DESC, at ASC
    LIMIT 64
  \`.columns({
    title: "string",
    detail: "string",
    at: "time",
    stage: ["waiting", "queued", "working", "unanswered", "failed"],
    label: "string",
    tone: ["live", "waiting", "failed"],
    icon: ["activity", "alert-triangle", "x-circle", "clock"],
  });

  const counts = sql\`
    SELECT count(*) AS open,
      coalesce(sum(stage IN ('unanswered', 'failed')), 0) AS stuck,
      coalesce(sum(stage = 'working'), 0) AS working
    FROM (\${staged})
  \`.columns({ open: "number", stuck: "number", working: "number" });

  // Answers are history, so they are counted from the events rather than the latest states.
  const answered = sql\`
    SELECT count(*) AS total FROM events
    WHERE source = '${eventSource}' AND eventType = '${REQUEST_EVENT_TYPE}'
      AND payload ->> '$.status' IN ('proposed', 'declined') AND occurredAt >= \${day}
  \`.columns({ total: "number" });

  const finished = sql\`
    SELECT title, detail, at,
      CASE status WHEN 'proposed' THEN 'Proposed' WHEN 'declined' THEN 'Declined'
        ELSE 'Withdrawn' END AS label,
      CASE status WHEN 'proposed' THEN 'live' WHEN 'declined' THEN 'waiting'
        ELSE 'muted' END AS tone
    FROM (\${requests})
    WHERE status <> 'requested'
    ORDER BY at DESC
    LIMIT 12
  \`.columns({
    title: "string",
    detail: "string",
    at: "time",
    label: "string",
    tone: ["live", "waiting", "muted"],
  });

  return ui.stack({ gap: "xl" }, [
    ui.grid({ columns: 3, gap: "lg" }, [
      ui.metric({
        label: "Waiting for the agent",
        value: counts.value("open", 0),
        format: "integer",
      }),
      ui.metric({
        label: "Need a person",
        value: counts.value("stuck", 0),
        format: "integer",
        detail: "Ask again from the document's or transaction's page in Bookkeeping",
      }),
      ui.metric({ label: "Answered today", value: answered.value("total", 0), format: "integer" }),
    ]),
    ui.panel(
      {
        title: "Requests",
        link: { label: "Bookkeeping agent", to: { kind: "agents" } },
      },
      [
        ui.rowList(
          { empty: "Nothing waits for the agent." },
          ui.each(open, (row) =>
            ui.listRow({ title: row.title, detail: row.detail, icon: row.icon, tone: row.tone }, [
              ui.stack({ gap: "md", direction: "row" }, [
                ui.badge({ label: row.label, tone: row.tone }),
                ui.relativeTime({ time: row.at }),
              ]),
            ]),
          ),
        ),
      ],
    ),
    ui.panel({ title: "Recently finished" }, [
      ui.rowList(
        { empty: "The agent has answered nothing yet." },
        ui.each(finished, (row) =>
          ui.listRow({ title: row.title, detail: row.detail }, [
            ui.stack({ gap: "md", direction: "row" }, [
              ui.badge({ label: row.label, tone: row.tone }),
              ui.relativeTime({ time: row.at }),
            ]),
          ]),
        ),
      ),
    ]),
  ]);
});
`;
}
