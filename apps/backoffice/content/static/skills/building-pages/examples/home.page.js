// The scope's home dashboard as a page: what needs a person, how automations and events did over
// the last day, connections, what is scheduled or waiting, and agents. Copy it into /workspace
// as a <name>.page.js file to open it or start from it.
export default page.define(
  ({
    collections,
    from,
    toArray,
    intervals,
    bucket,
    now,
    and,
    eq,
    gt,
    gte,
    not,
    isNull,
    add,
    divide,
    concat,
    coalesce,
    count,
    sum,
    max,
    caseWhen,
  }) => {
    const day = now.minus("24 hours");
    const hours = intervals({ every: "1 hour", since: day });

    const runs = from({ run: collections.workflowInstances }).select(({ run }) => ({
      id: run.id,
      workflow: coalesce(run.remoteWorkflowName, run.workflowName),
      workflowName: run.workflowName,
      instanceId: run.instanceId,
      status: run.status,
      error: caseWhen(
        and(not(isNull(run.errorName)), not(isNull(run.errorMessage))),
        concat(run.errorName, ": ", run.errorMessage),
        coalesce(run.errorName, run.errorMessage),
      ),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    }));

    // A waiting run asks a person when its latest interface comes from a completed step.
    const asking = from({ wait: collections.workflowWaits })
      .where(({ wait }) => not(isNull(wait.interfaceStepKey)))
      .groupBy(({ wait }) => [wait.runId, wait.interfaceStepKey])
      .select(({ wait }) => ({ runId: wait.runId, stepKey: wait.interfaceStepKey }));
    const awaitingInput = from({ ask: asking })
      .join({ run: runs }, ({ ask, run }) => eq(ask.runId, run.id))
      .join({ step: collections.workflowSteps }, ({ run, step }) => eq(run.id, step.instanceRef))
      .where(({ ask, step }) => eq(step.stepKey, ask.stepKey))
      .orderBy(({ run }) => run.updatedAt, "desc")
      .orderBy(({ run }) => run.id, "desc")
      .select(({ run, step }) => ({
        workflow: run.workflow,
        workflowName: run.workflowName,
        instanceId: run.instanceId,
        step: step.name,
        updatedAt: run.updatedAt,
      }));

    const recentFailures = from({ run: runs }).where(({ run }) =>
      and(eq(run.status, "errored"), gte(run.completedAt, day)),
    );
    const failingWorkflows = from({ run: recentFailures })
      .groupBy(({ run }) => run.workflow)
      .select(({ run }) => ({
        workflow: run.workflow,
        errored: count(run.id),
        lastFailure: max(run.updatedAt),
      }));
    const failing = from({ failing: failingWorkflows })
      .orderBy(({ failing }) => failing.lastFailure, "desc")
      .select(({ failing }) => ({
        workflow: failing.workflow,
        errored: failing.errored,
        latest: toArray(
          from({ run: recentFailures })
            .where(({ run }) => eq(run.workflow, failing.workflow))
            .orderBy(({ run }) => run.updatedAt, "desc")
            .limit(1)
            .select(({ run }) => ({
              workflowName: run.workflowName,
              instanceId: run.instanceId,
              error: coalesce(run.error, "Errored"),
              updatedAt: run.updatedAt,
            })),
        ),
      }));

    const unavailable = from({ connection: collections.connections })
      .where(({ connection }) => eq(connection.state, "unavailable"))
      .orderBy(({ connection }) => connection.service, "asc")
      .orderBy(({ connection }) => connection.connectionId, "asc")
      .select(({ connection }) => ({
        id: connection.connectionId,
        name: coalesce(connection.name, connection.connectionId),
        changedAt: connection.changedAt,
      }));

    const workflows = from({ run: runs })
      .groupBy(({ run }) => run.workflow)
      .select(({ run }) => ({
        workflow: run.workflow,
        started: sum(caseWhen(gte(run.createdAt, day), 1, 0)),
        completed: sum(caseWhen(and(eq(run.status, "complete"), gte(run.completedAt, day)), 1, 0)),
        errored: sum(caseWhen(and(eq(run.status, "errored"), gte(run.completedAt, day)), 1, 0)),
        lastActivity: max(run.updatedAt),
      }));
    const health = from({ workflow: workflows })
      .orderBy(({ workflow }) => workflow.lastActivity, "desc")
      .orderBy(({ workflow }) => workflow.workflow, "asc")
      .select(({ workflow }) => ({
        workflow: workflow.workflow,
        started: workflow.started,
        completed: workflow.completed,
        errored: workflow.errored,
        successRate: caseWhen(
          gt(add(workflow.completed, workflow.errored), 0),
          divide(workflow.completed, add(workflow.completed, workflow.errored)),
        ),
        rateTone: caseWhen(gt(workflow.errored, 0), "failed", "live"),
        latest: toArray(
          from({ run: runs })
            .where(({ run }) => eq(run.workflow, workflow.workflow))
            .orderBy(({ run }) => run.updatedAt, "desc")
            .limit(1)
            .select(({ run }) => ({
              workflowName: run.workflowName,
              instanceId: run.instanceId,
              status: run.status,
              tone: caseWhen(
                eq(run.status, "errored"),
                "failed",
                eq(run.status, "complete"),
                "live",
                "waiting",
              ),
              updatedAt: run.updatedAt,
            })),
        ),
        hourly: toArray(
          from({ run: runs })
            .where(({ run }) => and(eq(run.workflow, workflow.workflow), gte(run.createdAt, day)))
            .groupBy(({ run }) => bucket(run.createdAt, hours))
            .select(({ run }) => ({ hour: bucket(run.createdAt, hours), runs: count(run.id) })),
        ),
      }));

    const eventVolume = from({ event: collections.events })
      .where(({ event }) => gte(event.occurredAt, day))
      .groupBy(({ event }) => [bucket(event.occurredAt, hours), event.source])
      .select(({ event }) => ({
        hour: bucket(event.occurredAt, hours),
        source: event.source,
        events: count(event.id),
      }));

    const connections = from({ connection: collections.connections })
      .where(({ connection }) => not(eq(connection.state, "disconnected")))
      .orderBy(({ connection }) => connection.service, "asc")
      .orderBy(({ connection }) => connection.connectionId, "asc")
      .select(({ connection }) => ({
        id: connection.connectionId,
        name: coalesce(connection.name, connection.connectionId),
        state: connection.state,
        tone: caseWhen(eq(connection.state, "ready"), "live", "failed"),
        changedAt: connection.changedAt,
      }));

    // Waiting runs that do not ask a person, with what each waits for.
    const waiting = from({ run: runs })
      .where(({ run }) => eq(run.status, "waiting"))
      .leftJoin({ ask: asking }, ({ run, ask }) => eq(run.id, ask.runId))
      .where(({ ask }) => isNull(ask.runId))
      .orderBy(({ run }) => run.updatedAt, "asc")
      .select(({ run }) => ({
        workflow: run.workflow,
        workflowName: run.workflowName,
        instanceId: run.instanceId,
        updatedAt: run.updatedAt,
        waits: toArray(
          from({ wait: collections.workflowWaits })
            .where(({ wait }) => eq(wait.runId, run.id))
            .orderBy(({ wait }) => wait.eventType, "asc")
            .select(({ wait }) => ({ eventType: wait.eventType })),
        ),
      }));
    const schedules = from({ route: collections.routes })
      .join({ schedule: collections.routeScheduleStates }, ({ route, schedule }) =>
        eq(route.id, schedule.id),
      )
      .where(({ route, schedule }) =>
        and(
          eq(route.enabled, true),
          eq(route.trigger.kind, "schedule"),
          not(isNull(schedule.nextOccurrenceAt)),
        ),
      )
      .orderBy(({ schedule }) => schedule.nextOccurrenceAt, "asc")
      .select(({ route, schedule }) => ({
        id: route.id,
        name: route.name,
        at: schedule.nextOccurrenceAt,
      }));

    // The most recently active agents come first; agents without activity keep directory order.
    const agents = from({ agent: collections.agents })
      .orderBy(({ agent }) => isNull(agent.latestAt), "asc")
      .orderBy(({ agent }) => agent.latestAt, "desc")
      .orderBy(({ agent }) => agent.builtIn, "desc")
      .orderBy(({ agent }) => agent.agentName, "asc")
      .select(({ agent }) => {
        // Steers join the running turn, so only queued work waits on a stop.
        const paused = caseWhen(agent.paused, " · paused", "");
        return {
          agentName: agent.agentName,
          description: agent.definition.description,
          latestKind: agent.latestKind,
          latestAt: agent.latestAt,
          activity: caseWhen(
            agent.answering,
            "Answering",
            agent.paused,
            "Stopped",
            isNull(agent.latestKind),
            "No recorded activity",
            caseWhen(
              eq(agent.latestKind, "started"),
              "Started a turn",
              eq(agent.latestKind, "answered"),
              "Answered",
              eq(agent.latestKind, "cut-off"),
              "Turn cut off",
              caseWhen(
                eq(agent.latestKind, "failed"),
                "Turn failed",
                eq(agent.latestKind, "queued"),
                "Work queued",
                eq(agent.latestKind, "dispatched"),
                "Took queued work",
                caseWhen(
                  eq(agent.latestKind, "dropped"),
                  "Dropped queued work",
                  eq(agent.latestKind, "created"),
                  "Defined",
                  eq(agent.latestKind, "updated"),
                  "Definition updated",
                  caseWhen(
                    eq(agent.latestKind, "deleted"),
                    "Deleted",
                    eq(agent.latestKind, "stopped"),
                    "Stopped",
                    "Resumed",
                  ),
                ),
              ),
            ),
          ),
          queue: caseWhen(
            and(gt(agent.steering, 0), gt(agent.queued, 0)),
            concat(agent.steering, " steering · ", agent.queued, " queued", paused),
            gt(agent.steering, 0),
            concat(agent.steering, " steering"),
            gt(agent.queued, 0),
            concat(agent.queued, " queued", paused),
            "",
          ),
          queueTone: caseWhen(and(agent.paused, gt(agent.queued, 0)), "waiting", "info"),
          hourly: toArray(
            from({ turn: collections.agentTurns })
              .where(({ turn }) => and(eq(turn.agentName, agent.agentName), gte(turn.endedAt, day)))
              .groupBy(({ turn }) => bucket(turn.endedAt, hours))
              .select(({ turn }) => ({ hour: bucket(turn.endedAt, hours), turns: count(turn.id) })),
          ),
        };
      });

    return ui.stack({ gap: "lg" }, [
      ui.section({ label: "Needs attention" }, [
        ui.stack(
          { gap: "sm" },
          ui.each(awaitingInput, (run) =>
            ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
              ui.stack({ gap: "sm", direction: "row" }, [
                ui.icon({ name: "edit-3", tone: "waiting" }),
                ui.link({
                  label: run.workflow,
                  to: { kind: "run", workflowName: run.workflowName, instanceId: run.instanceId },
                }),
                ui.text({ text: run.step, tone: "muted" }),
              ]),
              ui.relativeTime({ time: run.updatedAt }),
            ]),
          ),
        ),
        ui.stack(
          { gap: "sm" },
          ui.each(failing, (workflow) =>
            ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
              ui.stack({ gap: "sm", direction: "row" }, [
                ui.icon({ name: "alert-triangle", tone: "failed" }),
                ui.link({
                  label: workflow.workflow,
                  to: {
                    kind: "run",
                    workflowName: workflow.latest[0].workflowName,
                    instanceId: workflow.latest[0].instanceId,
                  },
                }),
                ui.number({ value: workflow.errored, format: "integer", tone: "failed" }),
                ui.text({ text: workflow.latest[0].error, tone: "muted" }),
              ]),
              ui.relativeTime({ time: workflow.latest[0].updatedAt }),
            ]),
          ),
        ),
        ui.stack(
          { gap: "sm" },
          ui.each(unavailable, (connection) =>
            ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
              ui.stack({ gap: "sm", direction: "row" }, [
                ui.icon({ name: "alert-circle", tone: "failed" }),
                ui.link({ label: connection.name, to: { kind: "connection", id: connection.id } }),
                ui.text({ text: "Unavailable", tone: "muted" }),
              ]),
              ui.relativeTime({ time: connection.changedAt }),
            ]),
          ),
        ),
      ]),
      ui.grid({ columns: "main-side", gap: "lg" }, [
        ui.stack({ gap: "lg" }, [
          ui.section({ label: "Automations" }, [
            ui.stack(
              { gap: "sm" },
              ui.each(health, (row) =>
                ui.grid({ columns: 4, gap: "sm" }, [
                  ui.link({
                    label: row.workflow,
                    to: {
                      kind: "run",
                      workflowName: row.latest[0].workflowName,
                      instanceId: row.latest[0].instanceId,
                    },
                  }),
                  ui.sparkBars({
                    label: "Starts per hour",
                    rows: row.hourly,
                    axis: { field: "hour", intervals: hours },
                    value: "runs",
                  }),
                  ui.number({ value: row.successRate, format: "percent", tone: row.rateTone }),
                  ui.badge({ label: row.latest[0].status, tone: row.latest[0].tone }),
                ]),
              ),
            ),
          ]),
          ui.section({ label: "Events" }, [
            ui.barChart({
              label: "Events per hour",
              rows: eventVolume,
              axis: { field: "hour", intervals: hours },
              value: "events",
              series: "source",
            }),
          ]),
        ]),
        ui.stack({ gap: "lg" }, [
          ui.section({ label: "Connections" }, [
            ui.stack(
              { gap: "sm" },
              ui.each(connections, (connection) =>
                ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
                  ui.link({
                    label: connection.name,
                    to: { kind: "connection", id: connection.id },
                  }),
                  ui.badge({ label: connection.state, tone: connection.tone }),
                ]),
              ),
            ),
            ui.link({ label: "Show more on the Integrations page", to: { kind: "integrations" } }),
          ]),
          ui.section({ label: "Scheduled & waiting" }, [
            ui.stack(
              { gap: "sm" },
              ui.each(waiting, (run) =>
                ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
                  ui.stack({ gap: "sm", direction: "row" }, [
                    ui.icon({ name: "pause-circle", tone: "waiting" }),
                    ui.link({
                      label: run.workflow,
                      to: {
                        kind: "run",
                        workflowName: run.workflowName,
                        instanceId: run.instanceId,
                      },
                    }),
                    ui.stack(
                      { gap: "sm", direction: "row" },
                      ui.each(run.waits, (wait) =>
                        ui.badge({ label: wait.eventType, tone: "waiting" }),
                      ),
                    ),
                  ]),
                  ui.relativeTime({ time: run.updatedAt }),
                ]),
              ),
            ),
            ui.stack(
              { gap: "sm" },
              ui.each(schedules, (route) =>
                ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
                  ui.stack({ gap: "sm", direction: "row" }, [
                    ui.icon({ name: "calendar" }),
                    ui.link({ label: route.name, to: { kind: "route", id: route.id } }),
                  ]),
                  ui.relativeTime({ time: route.at }),
                ]),
              ),
            ),
          ]),
          ui.section({ label: "Agents" }, [
            ui.stack(
              { gap: "sm" },
              ui.each(agents, (agent) =>
                ui.stack({ gap: "sm", direction: "row", justify: "between" }, [
                  ui.stack({ gap: "sm", direction: "row" }, [
                    ui.icon({ name: "message-square" }),
                    ui.text({ text: agent.agentName }),
                    ui.text({ text: agent.activity, tone: "muted" }),
                    ui.relativeTime({ time: agent.latestAt }),
                  ]),
                  ui.stack({ gap: "sm", direction: "row" }, [
                    ui.when(
                      ui.is(agent.queue),
                      ui.badge({ label: agent.queue, tone: agent.queueTone }),
                    ),
                    ui.sparkBars({
                      label: "Turns per hour",
                      rows: agent.hourly,
                      axis: { field: "hour", intervals: hours },
                      value: "turns",
                    }),
                  ]),
                ]),
              ),
            ),
            ui.link({ label: "Show more on the Agents page", to: { kind: "agents" } }),
          ]),
        ]),
      ]),
    ]);
  },
);
