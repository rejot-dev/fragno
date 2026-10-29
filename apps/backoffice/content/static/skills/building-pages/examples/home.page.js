// The scope's home dashboard as a page: what needs a person, what is scheduled or waiting, and
// agents. What automations did lately lives on the dashboard's Activity tab. Copy it into
// /workspace as a <name>.page.js file to open it or start from it.
export default page.define({ title: "Home" }, ({ sql, now, intervals, bucket }) => {
  const day = now.minus("24 hours");
  const hours = intervals({ every: "1 hour", since: day });

  // A waiting run asks a person when its latest interface comes from a completed step.
  const awaitingInput = sql`
    SELECT coalesce(run.remoteWorkflowName, run.workflowName) AS workflow, run.workflowName,
      run.instanceId, step.name AS step, run.updatedAt
    FROM (SELECT DISTINCT runId, interfaceStepKey FROM workflow_waits
          WHERE interfaceStepKey IS NOT NULL) AS ask
    JOIN runs AS run ON run.id = ask.runId
    JOIN steps AS step ON step.runId = run.id AND step.stepKey = ask.interfaceStepKey
    ORDER BY run.updatedAt DESC, run.id DESC
  `.columns({
    workflow: "string",
    workflowName: "string",
    instanceId: "string",
    step: "string",
    updatedAt: "time",
  });

  // Each workflow whose runs failed today since one last completed, with its latest failure. A
  // failure that ends in the same instant as a completion still counts.
  const failing = sql`
    WITH run AS (
      SELECT *, coalesce(remoteWorkflowName, workflowName) AS workflow FROM runs
    ),
    recovered AS (
      SELECT workflow, max(completedAt) AS at FROM run WHERE status = 'complete' GROUP BY workflow
    ),
    failure AS (
      SELECT run.workflow, run.workflowName, run.instanceId, run.updatedAt,
        CASE WHEN run.errorName IS NOT NULL AND run.errorMessage IS NOT NULL
          THEN run.errorName || ': ' || run.errorMessage
          ELSE coalesce(run.errorName, run.errorMessage, 'Errored') END AS error,
        count(*) OVER (PARTITION BY run.workflow) AS errored,
        row_number() OVER (PARTITION BY run.workflow
                           ORDER BY run.updatedAt DESC, run.id DESC) AS recency
      FROM run
      LEFT JOIN recovered ON recovered.workflow = run.workflow
      WHERE run.status = 'errored' AND run.completedAt >= ${day}
        AND (recovered.at IS NULL OR run.completedAt >= recovered.at)
    )
    SELECT workflow, workflowName, instanceId, error, updatedAt, errored,
      CASE WHEN errored = 1 THEN '1 errored run' ELSE errored || ' errored runs' END AS erroredLabel
    FROM failure
    WHERE recency = 1
    ORDER BY updatedAt DESC
  `.columns({
    workflow: "string",
    workflowName: "string",
    instanceId: "string",
    error: "string",
    updatedAt: "time",
    errored: "number",
    erroredLabel: "string",
  });

  const unavailable = sql`
    SELECT connectionId AS id, displayName AS name,
      kindLabel || ' connection is unavailable' AS detail, changedAt
    FROM connections
    WHERE state = 'unavailable'
    ORDER BY service, connectionId
  `.columns({ id: "string", name: "string", detail: "string", changedAt: "time" });

  const needsAttention = sql`
    SELECT (SELECT count(*) FROM (${awaitingInput})) + (SELECT count(*) FROM (${failing}))
      + (SELECT count(*) FROM (${unavailable})) AS total
  `.columns({ total: "number" });

  // The runs of each workflow that wait for an event without asking a person, with every event
  // they wait for and the run that waited last.
  const waiting = sql`
    WITH run AS (
      SELECT run.*, coalesce(run.remoteWorkflowName, run.workflowName) AS workflow,
        row_number() OVER (PARTITION BY coalesce(run.remoteWorkflowName, run.workflowName)
                           ORDER BY run.updatedAt DESC, run.id DESC) AS recency
      FROM runs AS run
      WHERE run.status = 'waiting'
        AND NOT EXISTS (SELECT 1 FROM workflow_waits AS ask
                        WHERE ask.runId = run.id AND ask.interfaceStepKey IS NOT NULL)
    )
    SELECT latest.workflow, latest.workflowName, latest.instanceId, latest.updatedAt,
      (SELECT count(*) FROM run WHERE run.workflow = latest.workflow) AS runs,
      (SELECT json_group_array(json_object('eventType', eventType) ORDER BY eventType)
       FROM (SELECT DISTINCT wait.eventType FROM run
             JOIN workflow_waits AS wait ON wait.runId = run.id
             WHERE run.workflow = latest.workflow)) AS waits
    FROM run AS latest
    WHERE latest.recency = 1
    ORDER BY latest.updatedAt DESC
  `.columns({
    workflow: "string",
    workflowName: "string",
    instanceId: "string",
    updatedAt: "time",
    runs: "number",
    waits: { rows: { eventType: "string" } },
  });

  // The dashboard spells out common cron expressions; a page shows them as they are.
  const schedules = sql`
    SELECT route.id, route.name, schedule.nextOccurrenceAt AS at,
      CASE route.trigger ->> '$.cadence.kind' WHEN 'once' THEN 'Once'
        ELSE 'Cron ' || (route.trigger ->> '$.cadence.expression') END AS cadence
    FROM routes AS route
    JOIN route_schedules AS schedule ON schedule.id = route.id
    WHERE route.enabled = 1 AND route.trigger ->> '$.kind' = 'schedule'
      AND schedule.nextOccurrenceAt IS NOT NULL
    ORDER BY at
  `.columns({ id: "string", name: "string", at: "time", cadence: "string" });

  const upcoming = sql`
    SELECT (SELECT count(*) FROM (${waiting})) + (SELECT count(*) FROM (${schedules})) AS total
  `.columns({ total: "number" });

  // The most recently active agents come first; agents without activity keep built-in agents
  // first, then go by name. Steers join the running turn, so only queued work waits on a stop.
  const agents = sql`
    WITH turn AS (SELECT agentName, endedAt FROM agent_turns WHERE endedAt >= ${day}),
    counted AS (SELECT agentName, count(*) AS turns FROM turn GROUP BY agentName),
    hourly AS (
      SELECT agentName, json_group_array(json_object('hour', hour, 'turns', turns)) AS hourly
      FROM (
        SELECT agentName, ${bucket("endedAt", hours)} AS hour, count(*) AS turns
        FROM turn
        GROUP BY agentName, hour
      )
      GROUP BY agentName
    ),
    agent AS (
      SELECT *, CASE WHEN paused THEN ' · paused' ELSE '' END AS pausedLabel FROM agents
    )
    SELECT agent.agentName, agent.displayName AS name,
      agent.definition ->> '$.description' AS description, agent.activity, agent.latestKind,
      agent.latestAt,
      CASE
        WHEN agent.steering > 0 AND agent.queued > 0
          THEN agent.steering || ' steering · ' || agent.queued || ' queued' || agent.pausedLabel
        WHEN agent.steering > 0 THEN agent.steering || ' steering'
        WHEN agent.queued > 0 THEN agent.queued || ' queued' || agent.pausedLabel
        ELSE '' END AS queue,
      CASE WHEN agent.paused AND agent.queued > 0 THEN 'waiting' ELSE 'info' END AS queueTone,
      coalesce(counted.turns, 0) AS turns,
      coalesce(hourly.hourly, '[]') AS hourly
    FROM agent
    LEFT JOIN counted ON counted.agentName = agent.agentName
    LEFT JOIN hourly ON hourly.agentName = agent.agentName
    ORDER BY agent.latestAt IS NULL, agent.latestAt DESC, agent.builtIn DESC, agent.agentName
  `.columns({
    agentName: "string",
    name: "string",
    description: "string",
    activity: "string",
    latestKind: "string?",
    latestAt: "time?",
    queue: "string",
    queueTone: ["waiting", "info"],
    turns: "number",
    hourly: { rows: { hour: "time", turns: "number" } },
  });

  const comingUp = ui.panel({ title: "Coming up" }, [
    ui.when(
      ui.is(upcoming.value("total", 0), { eq: 0 }),
      ui.text({
        text: "Nothing is scheduled. Ask an agent to run something on a schedule, such as a summary every morning.",
        tone: "muted",
      }),
    ),
    ui.rowList(
      {},
      ui.each(schedules, (route) =>
        ui.listRow(
          {
            title: route.name,
            to: { kind: "route", id: route.id },
            detail: route.cadence,
            icon: "calendar",
          },
          [ui.relativeTime({ time: route.at })],
        ),
      ),
    ),
    ui.rowList(
      {},
      ui.each(waiting, (workflow) =>
        ui.listRow(
          {
            title: workflow.workflow,
            to: {
              kind: "run",
              workflowName: workflow.workflowName,
              instanceId: workflow.instanceId,
            },
            detail: "Waiting for an event",
            icon: "pause-circle",
          },
          [
            ui.stack(
              { gap: "sm", direction: "row" },
              ui.each(workflow.waits, (wait) =>
                ui.badge({ label: wait.eventType, tone: "waiting" }),
              ),
            ),
            ui.number({ value: workflow.runs, format: "integer", tone: "muted" }),
            ui.relativeTime({ time: workflow.updatedAt }),
          ],
        ),
      ),
    ),
  ]);

  return ui.stack({ gap: "xl" }, [
    ui.panel({ title: "Needs attention" }, [
      ui.when(
        ui.is(needsAttention.value("total", 0), { eq: 0 }),
        ui.stack({ gap: "sm", direction: "row" }, [
          ui.icon({ name: "check", tone: "live" }),
          ui.text({
            text: "Nothing needs attention. Runs are healthy and every connection is ready.",
          }),
        ]),
      ),
      ui.rowList(
        {},
        ui.each(awaitingInput, (run) =>
          ui.listRow(
            {
              title: run.workflow,
              to: { kind: "run", workflowName: run.workflowName, instanceId: run.instanceId },
              detail: "Waiting for your input",
              icon: "edit-3",
              tone: "info",
              expandLabel: "Respond",
              expanded: [
                ui.workflowResponse({
                  workflowName: run.workflowName,
                  instanceId: run.instanceId,
                }),
              ],
            },
            [ui.relativeTime({ time: run.updatedAt })],
          ),
        ),
      ),
      ui.rowList(
        {},
        ui.each(failing, (workflow) =>
          ui.listRow(
            {
              title: workflow.workflow,
              to: {
                kind: "run",
                workflowName: workflow.workflowName,
                instanceId: workflow.instanceId,
              },
              detail: workflow.error,
              icon: "alert-triangle",
              tone: "failed",
            },
            [
              ui.badge({ label: workflow.erroredLabel, tone: "failed" }),
              ui.relativeTime({ time: workflow.updatedAt }),
            ],
          ),
        ),
      ),
      ui.rowList(
        {},
        ui.each(unavailable, (connection) =>
          ui.listRow(
            {
              title: connection.name,
              to: { kind: "connection", id: connection.id },
              detail: connection.detail,
              icon: "link",
              tone: "waiting",
            },
            [ui.relativeTime({ time: connection.changedAt })],
          ),
        ),
      ),
    ]),
    ui.grid({ columns: 2, gap: "xl" }, [
      comingUp,
      ui.panel(
        {
          title: "Agents",
          link: { label: "Show more on the Agents page", to: { kind: "agents" } },
        },
        [
          ui.rowList(
            { empty: "No agents in this scope." },
            ui.each(agents, (agent) =>
              ui.listRow({ title: agent.name, detail: agent.activity, icon: "message-square" }, [
                ui.when(
                  ui.is(agent.queue),
                  ui.badge({ label: agent.queue, tone: agent.queueTone }),
                ),
                ui.relativeTime({ time: agent.latestAt }),
                ui.sparkBars({
                  label: "Turns per hour",
                  rows: agent.hourly,
                  axis: { field: "hour", intervals: hours },
                  value: "turns",
                }),
                ui.number({ value: agent.turns, format: "integer", tone: "muted" }),
              ]),
            ),
          ),
        ],
      ),
    ]),
  ]);
});
