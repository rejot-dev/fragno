// The scope's home dashboard as a page: what needs a person, how routes lead events to workflows,
// how automations and events did over the last day, connections, what is scheduled or waiting,
// and agents. Copy it into /workspace as a <name>.page.js file to open it or start from it.
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

  // Every workflow's runs today, its success rate, its latest run, and its starts per hour.
  const health = sql`
    WITH run AS (
      SELECT *, coalesce(remoteWorkflowName, workflowName) AS workflow FROM runs
    ),
    workflow AS (
      SELECT workflow,
        sum(createdAt >= ${day}) AS started,
        sum(status = 'complete' AND completedAt >= ${day}) AS completed,
        sum(status = 'errored' AND completedAt >= ${day}) AS errored,
        max(updatedAt) AS lastActivity
      FROM run
      GROUP BY workflow
    ),
    latest AS (
      SELECT workflow, workflowName, instanceId, status, updatedAt,
        row_number() OVER (PARTITION BY workflow ORDER BY updatedAt DESC, id DESC) AS recency
      FROM run
    ),
    hourly AS (
      SELECT workflow, json_group_array(json_object('hour', hour, 'runs', runs)) AS hourly
      FROM (
        SELECT workflow, ${bucket("createdAt", hours)} AS hour, count(*) AS runs
        FROM run
        WHERE createdAt >= ${day}
        GROUP BY workflow, hour
      )
      GROUP BY workflow
    )
    SELECT workflow.workflow, workflow.started, workflow.completed, workflow.errored,
      CASE WHEN workflow.completed + workflow.errored > 0
        THEN 1.0 * workflow.completed / (workflow.completed + workflow.errored) END AS successRate,
      CASE WHEN workflow.errored > 0 THEN 'failed' ELSE 'live' END AS rateTone,
      latest.workflowName, latest.instanceId, latest.status, latest.updatedAt,
      coalesce(hourly.hourly, '[]') AS hourly
    FROM workflow
    JOIN latest ON latest.workflow = workflow.workflow AND latest.recency = 1
    LEFT JOIN hourly ON hourly.workflow = workflow.workflow
    ORDER BY workflow.lastActivity DESC, workflow.workflow
  `.columns({
    workflow: "string",
    started: "number",
    completed: "number",
    errored: "number",
    successRate: "number?",
    rateTone: ["failed", "live"],
    workflowName: "string",
    instanceId: "string",
    // Listing the values a column holds lets components that take one of them show it.
    status: ["active", "paused", "waiting", "complete", "errored", "terminated"],
    updatedAt: "time",
    hourly: { rows: { hour: "time", runs: "number" } },
  });

  const eventVolume = sql`
    SELECT ${bucket("occurredAt", hours)} AS hour, source, count(*) AS events
    FROM events
    WHERE occurredAt >= ${day}
    GROUP BY hour, source
  `.columns({ hour: "time", source: "string", events: "number" });

  const connections = sql`
    SELECT connectionId AS id, displayName AS name, kindLabel AS kind, state,
      CASE WHEN state = 'ready' THEN 'Ready' ELSE 'Unavailable' END AS stateLabel,
      CASE WHEN state = 'ready' THEN 'live' ELSE 'waiting' END AS tone, changedAt
    FROM connections
    WHERE state <> 'disconnected'
    ORDER BY service, connectionId
  `.columns({
    id: "string",
    name: "string",
    kind: "string",
    state: ["ready", "unavailable"],
    stateLabel: "string",
    tone: ["live", "waiting"],
    changedAt: "time",
  });

  // Waiting runs that do not ask a person, with what each waits for.
  const waiting = sql`
    SELECT coalesce(run.remoteWorkflowName, run.workflowName) AS workflow, run.workflowName,
      run.instanceId, run.updatedAt,
      (SELECT json_group_array(json_object('eventType', wait.eventType) ORDER BY wait.eventType)
       FROM workflow_waits AS wait WHERE wait.runId = run.id) AS waits
    FROM runs AS run
    WHERE run.status = 'waiting'
      AND NOT EXISTS (SELECT 1 FROM workflow_waits AS ask
                      WHERE ask.runId = run.id AND ask.interfaceStepKey IS NOT NULL)
    ORDER BY run.updatedAt
  `.columns({
    workflow: "string",
    workflowName: "string",
    instanceId: "string",
    updatedAt: "time",
    waits: { rows: { eventType: "string" } },
  });

  const schedules = sql`
    SELECT route.id, route.name, schedule.nextOccurrenceAt AS at
    FROM routes AS route
    JOIN route_schedules AS schedule ON schedule.id = route.id
    WHERE route.enabled = 1 AND route.trigger ->> '$.kind' = 'schedule'
      AND schedule.nextOccurrenceAt IS NOT NULL
    ORDER BY at
  `.columns({ id: "string", name: "string", at: "time" });

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

  const scheduledAndWaiting = ui.panel({ title: "Scheduled & waiting" }, [
    ui.rowList(
      {},
      ui.each(waiting, (run) =>
        ui.listRow(
          {
            title: run.workflow,
            to: { kind: "run", workflowName: run.workflowName, instanceId: run.instanceId },
            detail: "Waiting for an event",
            icon: "pause-circle",
          },
          [
            ui.stack(
              { gap: "sm", direction: "row" },
              ui.each(run.waits, (wait) => ui.badge({ label: wait.eventType, tone: "waiting" })),
            ),
            ui.relativeTime({ time: run.updatedAt }),
          ],
        ),
      ),
    ),
    ui.rowList(
      {},
      ui.each(schedules, (route) =>
        ui.listRow(
          {
            title: route.name,
            to: { kind: "route", id: route.id },
            detail: "Scheduled route",
            icon: "clock",
          },
          [ui.relativeTime({ time: route.at })],
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
    ui.panel({ title: "Orchestration" }, [ui.orchestration({})]),
    ui.grid({ columns: "main-side", gap: "xl" }, [
      ui.stack({ gap: "xl" }, [
        ui.panelTable(
          {
            title: "Automations",
            columns: [
              { label: "Runs · 24 hours" },
              { label: "Success", align: "end" },
              { label: "Last run", align: "end" },
            ],
            empty: "No workflow has run in this scope yet.",
          },
          ui.each(health, (row) =>
            ui.panelTableRow(
              {
                title: row.workflow,
                to: { kind: "run", workflowName: row.workflowName, instanceId: row.instanceId },
              },
              [
                ui.stack({ gap: "md", direction: "row" }, [
                  ui.sparkBars({
                    label: "Starts per hour",
                    rows: row.hourly,
                    axis: { field: "hour", intervals: hours },
                    value: "runs",
                  }),
                  ui.number({ value: row.started, format: "integer", tone: "muted" }),
                ]),
                ui.number({ value: row.successRate, format: "percent", tone: row.rateTone }),
                ui.stack({ gap: "md", direction: "row" }, [
                  ui.runStatus({ status: row.status }),
                  ui.relativeTime({ time: row.updatedAt }),
                ]),
              ],
            ),
          ),
        ),
        ui.panel({ title: "Events" }, [
          ui.when(
            ui.is(eventVolume.value("source", "")),
            ui.barChart({
              label: "Events per hour",
              rows: eventVolume,
              axis: { field: "hour", intervals: hours },
              value: "events",
              series: "source",
            }),
          ),
          ui.when(
            ui.is(eventVolume.value("source", ""), { not: true }),
            ui.text({ text: "No events arrived in the last 24 hours." }),
          ),
        ]),
      ]),
      ui.stack({ gap: "xl" }, [
        ui.panel(
          {
            title: "Connections",
            link: { label: "Show more on the Integrations page", to: { kind: "integrations" } },
          },
          [
            ui.rowList(
              { empty: "No connections yet. Ask your agent to add one." },
              ui.each(connections, (connection) =>
                ui.listRow(
                  {
                    title: connection.name,
                    to: { kind: "connection", id: connection.id },
                    detail: connection.kind,
                  },
                  [
                    ui.relativeTime({ time: connection.changedAt }),
                    ui.badge({ label: connection.stateLabel, tone: connection.tone }),
                  ],
                ),
              ),
            ),
          ],
        ),
        ui.when(ui.is(upcoming.value("total", 0), { gt: 0 }), scheduledAndWaiting),
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
    ]),
  ]);
});
