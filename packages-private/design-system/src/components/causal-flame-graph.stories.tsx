import { useState } from "react";

import { CausalFlameGraph } from "./causal-flame-graph";
import type {
  CausalFlameNode,
  CausalFlameStatus,
  CausalFlameTiming,
} from "./causal-flame-graph-model";
import { WorkflowRunTimeline } from "./workflow-run-timeline";
import type { WorkflowRunNode } from "./workflow-run-timeline-model";

export default { title: "Data/Causal flame graph" };

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);
const ms = (milliseconds: number) => T0 + milliseconds;
const s = (seconds: number) => T0 + seconds * 1000;
// Live trees are open, so they start relative to when the stories load.
const RECENTLY = Date.now() - 6_000;

function node(
  id: string,
  kind: CausalFlameNode["kind"],
  label: string,
  timing: CausalFlameTiming,
  fields: { detail?: string; status?: CausalFlameStatus; children?: CausalFlameNode[] } = {},
): CausalFlameNode {
  return {
    id,
    kind,
    label,
    detail: fields.detail ?? null,
    status: fields.status ?? "ok",
    timing,
    children: fields.children ?? [],
  };
}

const at = (time: number): CausalFlameTiming => ({ kind: "instant", at: time });
// Started runs span from creation: the runner cannot tell queueing from work.
const ran = (createdAt: number, endedAt: number | null): CausalFlameTiming => ({
  kind: "span",
  activity: "work",
  queuedAt: createdAt,
  startedAt: createdAt,
  endedAt,
});
const waited = (startedAt: number, endedAt: number | null): CausalFlameTiming => ({
  kind: "span",
  activity: "wait",
  queuedAt: startedAt,
  startedAt,
  endedAt,
});

function Frame({ title, root }: { title: string; root: CausalFlameNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  return (
    <div className="max-w-5xl">
      <CausalFlameGraph
        title={title}
        root={root}
        selectedId={selectedId}
        emphasizedId={null}
        onSelect={setSelectedId}
        cursor={cursor}
        onCursorChange={setCursor}
        surface="card"
      />
    </div>
  );
}

const githubIssueTriage = node(
  "github-delivery-1",
  "event",
  "github · webhook.received",
  at(ms(0)),
  {
    detail: "issues.opened delivery 7f3c…a91",
    children: [
      node(
        "reclassified:promote-issue-opened:github-delivery-1",
        "event",
        "github · issues.opened",
        at(ms(180)),
        {
          detail: "via route Promote opened issues",
          children: [
            node("dispatch:assist", "route", "Assist the sender skipped", at(ms(230)), {
              status: "skipped",
              detail: "No external sender linked to a user",
            }),
            node("triage-issue-42", "workflow", "triage-issue", ran(ms(240), s(7.4)), {
              detail: "codemode-script · triage-issue-42",
              children: [
                node("triage-issue-42/do:classify", "step", "classify issue", at(s(1.9)), {
                  detail: "Committed after one attempt",
                }),
                node("triage-issue-42/do:label", "step", "apply labels", at(s(2.6))),
                node("evt-triaged", "event", "github · issue.triaged", at(s(2.7)), {
                  detail: "fired by triage-issue",
                  children: [
                    node("forwarded:evt-triaged", "event", "project · issue.triaged", at(s(3.0)), {
                      detail: "via route Forward to Launch Plan",
                      children: [
                        node("notify-team-42", "workflow", "notify-team", ran(s(3.1), s(5.8)), {
                          children: [
                            node("notify/do:compose", "step", "compose message", at(s(4.9))),
                            node("notify/do:send", "step", "send to Telegram", at(s(5.7))),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                node("triage-issue-42/do:comment", "step", "post summary comment", at(s(7.2))),
              ],
            }),
            node("sync-linear-42", "workflow", "sync-to-linear", ran(ms(260), s(2.2)), {
              status: "failed",
              detail: "Linear API returned 401 after 3 attempts",
              children: [
                node("sync/do:create", "step", "create Linear issue", at(s(2.1)), {
                  status: "failed",
                  detail: "401 Unauthorized",
                }),
              ],
            }),
          ],
        },
      ),
    ],
  },
);

export function GitHubIssueTriage() {
  return <Frame title="Issue #42 opened" root={githubIssueTriage} />;
}

const approvalWaitedTwoDays = node(
  "form-response-9",
  "event",
  "forms · response.submitted",
  at(s(0)),
  {
    detail: "Expense request from ada@example.com",
    children: [
      node("approve-expense-9", "workflow", "approve-expense", ran(s(0.2), s(2 * 86_400 + 40)), {
        children: [
          node("approve/do:score", "step", "score request", at(s(1.4))),
          node(
            "approve/wait:approval",
            "step",
            "wait for manager approval",
            waited(s(1.5), s(2 * 86_400 + 12)),
            {
              detail: "waitForEvent approval.decided",
            },
          ),
          node("evt-approved", "event", "approvals · expense.approved", at(s(2 * 86_400 + 14)), {
            detail: "fired by approve-expense",
            children: [
              node(
                "pay-expense-9",
                "workflow",
                "pay-expense",
                ran(s(2 * 86_400 + 15), s(2 * 86_400 + 31)),
                {
                  children: [
                    node("pay/do:transfer", "step", "schedule transfer", at(s(2 * 86_400 + 30))),
                  ],
                },
              ),
            ],
          }),
          node("approve/do:archive", "step", "archive thread", at(s(2 * 86_400 + 39))),
        ],
      }),
    ],
  },
);

export function LongWaitCompressed() {
  return <Frame title="Expense approval" root={approvalWaitedTwoDays} />;
}

const liveRun = node("telegram-update-77", "event", "telegram · message.received", at(RECENTLY), {
  detail: "Chat 1001",
  children: [
    node(
      "pi-turn-77",
      "workflow",
      "answer-in-chat",
      {
        kind: "span",
        activity: "work",
        queuedAt: RECENTLY + 80,
        startedAt: RECENTLY + 80,
        endedAt: null,
      },
      {
        status: "running",
        children: [
          node("pi/do:context", "step", "load conversation", at(RECENTLY + 900)),
          node("pi/wait:tool", "step", "wait for sandbox", waited(RECENTLY + 1_400, null), {
            status: "waiting",
          }),
        ],
      },
    ),
    node(
      "audit-77",
      "workflow",
      "audit-log",
      { kind: "queued", queuedAt: RECENTLY + 120 },
      {
        status: "pending",
        detail: "Queued behind 3 runs",
      },
    ),
  ],
});

export function Live() {
  return <Frame title="Telegram message" root={liveRun} />;
}

export function LoneOrigin() {
  return (
    <Frame
      title="Webhook with no matching route"
      root={node("api-delivery-3", "event", "api · webhook.received", at(T0), {
        detail: "No route matched this event",
      })}
    />
  );
}

const scheduled = (time: number) => at(time);
const work = (startedAt: number, endedAt: number): CausalFlameTiming => ({
  kind: "span",
  activity: "work",
  queuedAt: startedAt,
  startedAt,
  endedAt,
});

const failedInFirstTick = node(
  "schedule-1",
  "event",
  "scheduler · schedule.triggered",
  scheduled(ms(0)),
  {
    children: [
      node(
        "run:write-current-connections",
        "workflow",
        "write-current-connections",
        work(ms(54), ms(158)),
        {
          status: "failed",
          detail: "Connection store rejected the write: 403 Forbidden",
          children: [
            node(
              "step:fetch-current-connections",
              "step",
              "fetch-current-connections",
              {
                kind: "span",
                activity: "work",
                queuedAt: ms(54),
                startedAt: ms(54),
                endedAt: ms(154),
              },
              { status: "failed", detail: "403 Forbidden" },
            ),
          ],
        },
      ),
    ],
  },
);

export function FailedInFirstTick() {
  return <Frame title="scheduler · schedule.triggered" root={failedInFirstTick} />;
}

const sequentialSteps = node(
  "schedule-2",
  "event",
  "scheduler · schedule.triggered",
  scheduled(ms(0)),
  {
    children: [
      node(
        "run:write-current-connections-2",
        "workflow",
        "write-current-connections-2",
        work(ms(100), ms(2_680)),
        {
          children: [
            node("step:fetch", "step", "fetch-current-connections", work(ms(100), ms(230))),
            node(
              "step:write-file",
              "step",
              "write-current-connections-file",
              work(ms(240), ms(350)),
            ),
            node("step:search", "step", "search-technical-writer-skills", work(ms(360), ms(2_570))),
            node(
              "step:write-skills",
              "step",
              "write-technical-writer-skills",
              work(ms(2_580), ms(2_670)),
            ),
          ],
        },
      ),
    ],
  },
);

export function SequentialSteps() {
  return <Frame title="scheduler · schedule.triggered" root={sequentialSteps} />;
}

// The steps of `sequentialSteps` as its run's program lists them, under the same ids, so the
// flame graph and the step list can share a selection.
function completedStep(id: string, label: string, from: number, to: number): WorkflowRunNode {
  return {
    kind: "step",
    step: {
      id,
      label,
      detail: null,
      status: "completed",
      activity: "work",
      attempts: { count: 1, max: 1 },
      timing: { kind: "span", startedAt: ms(from), endedAt: ms(to) },
      children: [],
    },
  };
}

const sequentialRunSteps: WorkflowRunNode[] = [
  completedStep("step:fetch", "fetch-current-connections", 100, 230),
  completedStep("step:write-file", "write-current-connections-file", 240, 350),
  completedStep("step:search", "search-technical-writer-skills", 360, 2_570),
  completedStep("step:write-skills", "write-technical-writer-skills", 2_580, 2_670),
];

/**
 * How a trace page pairs the chart with the selected run: the chart owns time and replay, and the
 * run's steps follow its playhead and share its selection.
 */
export function TraceWithRunSteps() {
  const [selectedId, setSelectedId] = useState<string | null>("run:write-current-connections-2");
  const [hoveredStepId, setHoveredStepId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const selectedStepId = selectedId?.startsWith("step:") ? selectedId : null;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <CausalFlameGraph
        title="scheduler · schedule.triggered"
        root={sequentialSteps}
        selectedId={selectedId}
        emphasizedId={hoveredStepId}
        onSelect={setSelectedId}
        cursor={cursor}
        onCursorChange={setCursor}
        surface="flush"
      />
      <WorkflowRunTimeline
        title="write-current-connections-2"
        status="complete"
        trigger="scheduler · schedule.triggered"
        createdAt={ms(100)}
        startedAt={ms(100)}
        endedAt={ms(2_680)}
        nodes={sequentialRunSteps}
        events={[]}
        selectedStepId={selectedStepId}
        onSelectStep={(stepId) => {
          setSelectedId(stepId === selectedStepId ? "run:write-current-connections-2" : stepId);
        }}
        presentation={{ kind: "embedded", cursor, onHoverStep: setHoveredStepId }}
      />
    </div>
  );
}
