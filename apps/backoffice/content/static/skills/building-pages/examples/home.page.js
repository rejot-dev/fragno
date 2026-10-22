// The scope's home dashboard as a page: what needs a person, how automations and events did over
// the last day, connections, what is scheduled or waiting, and agents. Copy it into /workspace
// as a <name>.page.js file to open it or start from it.
export default page.define(
  ({
    collections,
    from,
    toArray,
    unionAll,
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
        erroredLabel: caseWhen(
          eq(failing.errored, 1),
          "1 errored run",
          concat(failing.errored, " errored runs"),
        ),
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
        name: connection.displayName,
        detail: concat(connection.kindLabel, " connection is unavailable"),
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
              statusLabel: caseWhen(
                eq(run.status, "active"),
                "Running",
                eq(run.status, "complete"),
                "Complete",
                eq(run.status, "errored"),
                "Errored",
                caseWhen(
                  eq(run.status, "terminated"),
                  "Terminated",
                  eq(run.status, "paused"),
                  "Paused",
                  "Waiting",
                ),
              ),
              tone: caseWhen(
                eq(run.status, "active"),
                "info",
                eq(run.status, "complete"),
                "live",
                eq(run.status, "errored"),
                "failed",
                caseWhen(eq(run.status, "terminated"), "muted", "waiting"),
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
        name: connection.displayName,
        kind: connection.kindLabel,
        state: connection.state,
        stateLabel: caseWhen(eq(connection.state, "ready"), "Ready", "Unavailable"),
        tone: caseWhen(eq(connection.state, "ready"), "live", "waiting"),
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

    const turnCounts = from({ turn: collections.agentTurns })
      .where(({ turn }) => gte(turn.endedAt, day))
      .groupBy(({ turn }) => turn.agentName)
      .select(({ turn }) => ({ agentName: turn.agentName, turns: count(turn.id) }));

    // The most recently active agents come first; agents without activity keep directory order.
    const agents = from({ agent: collections.agents })
      .leftJoin({ counted: turnCounts }, ({ agent, counted }) =>
        eq(agent.agentName, counted.agentName),
      )
      .orderBy(({ agent }) => isNull(agent.latestAt), "asc")
      .orderBy(({ agent }) => agent.latestAt, "desc")
      .orderBy(({ agent }) => agent.builtIn, "desc")
      .orderBy(({ agent }) => agent.agentName, "asc")
      .select(({ agent, counted }) => {
        // Steers join the running turn, so only queued work waits on a stop.
        const paused = caseWhen(agent.paused, " · paused", "");
        return {
          agentName: agent.agentName,
          name: agent.displayName,
          description: agent.definition.description,
          latestKind: agent.latestKind,
          latestAt: agent.latestAt,
          activity: agent.activity,
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
          turns: coalesce(counted.turns, 0),
          hourly: toArray(
            from({ turn: collections.agentTurns })
              .where(({ turn }) => and(eq(turn.agentName, agent.agentName), gte(turn.endedAt, day)))
              .groupBy(({ turn }) => bucket(turn.endedAt, hours))
              .select(({ turn }) => ({ hour: bucket(turn.endedAt, hours), turns: count(turn.id) })),
          ),
        };
      });

    // Scheduled & waiting shows only while something is scheduled or waiting, as on the dashboard.
    const upcomingIds = unionAll(
      from({ run: waiting }).select(({ run }) => ({ id: run.instanceId })),
      from({ route: schedules }).select(({ route }) => ({ id: route.id })),
    );
    const nothingNeedsAttention = ui.when(
      ui.is(awaitingInput.value("workflow", ""), { not: true }),
      ui.when(
        ui.is(failing.value("workflow", ""), { not: true }),
        ui.when(
          ui.is(unavailable.value("id", ""), { not: true }),
          ui.stack({ gap: "sm", direction: "row" }, [
            ui.icon({ name: "check", tone: "live" }),
            ui.text({
              text: "Nothing needs attention. Runs are healthy and every connection is ready.",
            }),
          ]),
        ),
      ),
    );
    const upcoming = ui.panel({ title: "Scheduled & waiting" }, [
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
        nothingNeedsAttention,
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
                  workflowName: workflow.latest[0].workflowName,
                  instanceId: workflow.latest[0].instanceId,
                },
                detail: workflow.latest[0].error,
                icon: "alert-triangle",
                tone: "failed",
              },
              [
                ui.badge({ label: workflow.erroredLabel, tone: "failed" }),
                ui.relativeTime({ time: workflow.latest[0].updatedAt }),
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
                  to: {
                    kind: "run",
                    workflowName: row.latest[0].workflowName,
                    instanceId: row.latest[0].instanceId,
                  },
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
                    ui.badge({ label: row.latest[0].statusLabel, tone: row.latest[0].tone }),
                    ui.relativeTime({ time: row.latest[0].updatedAt }),
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
          ui.when(ui.is(upcomingIds.value("id", "")), upcoming),
          ui.panel(
            {
              title: "Agents",
              link: { label: "Show more on the Agents page", to: { kind: "agents" } },
            },
            [
              ui.rowList(
                { empty: "No agents in this scope." },
                ui.each(agents, (agent) =>
                  ui.listRow(
                    { title: agent.name, detail: agent.activity, icon: "message-square" },
                    [
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
                    ],
                  ),
                ),
              ),
            ],
          ),
        ]),
      ]),
    ]);
  },
);
