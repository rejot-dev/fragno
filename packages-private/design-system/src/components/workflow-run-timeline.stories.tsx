import { useMemo, useState } from "react";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

// The visualizer's own fixture corpus, read as-is so these stories track its expectations.
import { WORKFLOW_VISUALIZER_FIXTURES } from "../../../../packages/workflow-visualizer-tokens/src/test-support/workflow-fixtures";
import { WorkflowRunTimeline } from "./workflow-run-timeline";
import {
  workflowRunNodesFromGraph,
  type WorkflowRunStepIteration,
  type WorkflowRunStepRuntime,
} from "./workflow-run-timeline-graph";
import type {
  WorkflowRunEvent,
  WorkflowRunNode,
  WorkflowRunStatus,
  WorkflowRunStep,
} from "./workflow-run-timeline-model";

export default { title: "Data/Workflow run timeline" };

const T0 = Date.UTC(2026, 9, 4, 9, 0, 0);
const s = (seconds: number) => T0 + seconds * 1000;
// Queued runs are live, so they are enqueued relative to when the stories load.
const RECENTLY = Date.now() - 2_400;

function step(
  id: string,
  label: string,
  fields: Partial<Omit<WorkflowRunStep, "id" | "label">>,
): WorkflowRunNode {
  return {
    kind: "step",
    step: {
      id,
      label,
      detail: null,
      status: "pending",
      activity: "work",
      attempts: { count: 0, max: 1 },
      timing: { kind: "unstarted" },
      children: [],
      iterations: [],
      ...fields,
    },
  };
}

function Frame({
  title,
  status,
  trigger,
  createdAt,
  startedAt,
  endedAt,
  nodes,
  events,
  diagnostics,
}: {
  title: string;
  status: WorkflowRunStatus;
  trigger: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  nodes: readonly WorkflowRunNode[];
  events: readonly WorkflowRunEvent[];
  diagnostics: number;
}) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  return (
    <div className="max-w-5xl">
      <WorkflowRunTimeline
        title={title}
        status={status}
        trigger={trigger}
        createdAt={createdAt}
        startedAt={startedAt}
        endedAt={endedAt}
        nodes={nodes}
        events={events}
        selectedStepId={selectedStepId}
        onSelectStep={setSelectedStepId}
        presentation={{
          kind: "standalone",
          meta: (
            <>
              <span className="font-mono">n296bqwlo6pm</span>
              {diagnostics === 0 ? null : (
                <span className="text-[var(--bo-waiting)]">
                  {diagnostics} parser {diagnostics === 1 ? "note" : "notes"}
                </span>
              )}
            </>
          ),
          actions: null,
          surface: "card",
        }}
      />
    </div>
  );
}

// Mirrors the shape of a nightly import: a parallel fan-out, a retried step that exhausted its
// attempts, and a condition whose untaken branch reconciles to skipped.
const branchingNodes: WorkflowRunNode[] = [
  step("pull", "pull orders", {
    status: "completed",
    timing: { kind: "span", startedAt: s(0), endedAt: s(8) },
    detail: "1000 rows",
  }),
  {
    kind: "fork",
    id: "prepare",
    runs: "all",
    branches: [
      {
        id: "prepare-orders",
        label: null,
        nodes: [
          step("prepare-orders", "prepare orders", {
            status: "completed",
            timing: { kind: "committed", at: s(8.4) },
          }),
        ],
      },
      {
        id: "daily-dims",
        label: null,
        nodes: [
          step("daily-dims", "daily_dims", {
            status: "completed",
            timing: { kind: "span", startedAt: s(8), endedAt: s(15) },
            children: [
              {
                id: "daily-dims-fetch",
                label: "fetch dimension table",
                detail: null,
                status: "completed",
                activity: "work",
                attempts: { count: 1, max: 1 },
                timing: { kind: "span", startedAt: s(8), endedAt: s(12) },
                children: [],
                iterations: [],
              },
              {
                id: "daily-dims-write",
                label: "write snapshot",
                detail: null,
                status: "completed",
                activity: "work",
                attempts: { count: 1, max: 1 },
                timing: { kind: "span", startedAt: s(12), endedAt: s(15) },
                children: [],
                iterations: [],
              },
            ],
          }),
        ],
      },
    ],
  },
  step("wait-inputs", "wait for inputs", {
    status: "completed",
    activity: "wait",
    detail: "inputs-ready",
    timing: { kind: "span", startedAt: s(15), endedAt: s(18) },
  }),
  step("load-regions", "load regions", {
    status: "failed",
    detail: "RegionTimeout: eu-central did not acknowledge",
    attempts: { count: 3, max: 3 },
    timing: { kind: "span", startedAt: s(18), endedAt: s(33) },
  }),
  step("counts-match", "counts match?", {
    status: "completed",
    timing: { kind: "span", startedAt: s(33), endedAt: s(34) },
  }),
  {
    kind: "fork",
    id: "counts",
    runs: "one",
    branches: [
      {
        id: "ok",
        label: "ok",
        nodes: [step("promote", "promote to prod", { status: "skipped" })],
      },
      {
        id: "mismatch",
        label: "mismatch",
        nodes: [
          step("quarantine", "quarantine", {
            status: "completed",
            timing: { kind: "span", startedAt: s(34), endedAt: s(37) },
          }),
        ],
      },
    ],
  },
  step("record-summary", "record summary", {
    status: "completed",
    timing: { kind: "span", startedAt: s(37), endedAt: s(38) },
  }),
];

const branchingEvents: WorkflowRunEvent[] = [
  { id: "e1", at: s(15.2), source: "inputs-ready", message: '{"source":"scheduler"}' },
  {
    id: "e2",
    at: s(33.5),
    source: "counts match?",
    message: "Expected 3000 rows; observed 2812. Taking mismatch branch.",
  },
];

export function Branching() {
  return (
    <Frame
      title="nightly_orders"
      status="errored"
      trigger="schedule · 0 9 * * *"
      createdAt={s(-1.4)}
      startedAt={s(0)}
      endedAt={s(38)}
      nodes={branchingNodes}
      events={branchingEvents}
      diagnostics={1}
    />
  );
}

// Taken from a local interactive-chat-workflow run: waits have real spans, while each command
// step only records the moment it committed.
const chatStart = 1_790_667_675_210;
const c = (ms: number) => chatStart + ms;

function waitForCommand(id: string, startedAt: number, endedAt: number | null): WorkflowRunNode {
  return step(id, "wait-command", {
    status: endedAt === null ? "waiting" : "completed",
    activity: "wait",
    detail: "command",
    timing: { kind: "span", startedAt, endedAt },
  });
}

function runCommand(id: string, label: string, committedAt: number): WorkflowRunNode {
  return step(id, label, {
    status: "completed",
    attempts: { count: 1, max: 1 },
    timing: { kind: "committed", at: committedAt },
  });
}

const chatNodes: WorkflowRunNode[] = [
  waitForCommand("wait-0", c(0), c(0)),
  runCommand("command-0", "command:prompt_zuz20dwfzwe", c(2_644)),
  waitForCommand("wait-1", c(2_644), c(11_023)),
  runCommand("command-1", "command:prompt_qsqoaalby2u", c(19_585)),
  waitForCommand("wait-2", c(19_585), c(26_077)),
  runCommand("command-2", "command:prompt_h22csrqeshv", c(30_736)),
  waitForCommand("wait-3", c(30_736), null),
];

export function WaitingForEvent() {
  return (
    <Frame
      title="interactive-chat-workflow"
      status="waiting"
      trigger="pi · session.created"
      createdAt={chatStart - 213}
      startedAt={chatStart}
      endedAt={null}
      nodes={chatNodes}
      diagnostics={0}
      events={[
        {
          id: "c1",
          at: chatStart + 26_077,
          source: "command",
          message: '{"commandId":"prompt_h22csrqeshv","text":"Summarise the inbox"}',
        },
      ]}
    />
  );
}

export function NotStarted() {
  return (
    <Frame
      title="workspace-file-initialization"
      status="active"
      trigger="auth · organization.created"
      createdAt={RECENTLY}
      startedAt={null}
      endedAt={null}
      nodes={[
        step("configure", "configure upload database connection", {}),
        step("seed-files", "seed workspace starter files", {}),
        step("seed-routes", "seed starter automation routes", {}),
      ]}
      events={[]}
      diagnostics={0}
    />
  );
}

type FixtureRun = "simulated" | "not started";

const unstartedRuntime = {
  kind: "single",
  status: "pending",
  attempts: { count: 0, max: 1 },
  timing: { kind: "unstarted" },
  detail: null,
} as const;

const LOOP_PASSES = 3;

/**
 * Folds the passes of a loop body, which share one shape, into its steps: each step that ran
 * reads as its newest iteration, over the time from its first to its newest.
 */
function foldLoopPasses(passes: readonly (readonly WorkflowRunNode[])[]): WorkflowRunNode[] {
  const [first = []] = passes;
  return first.map((node, index): WorkflowRunNode => {
    const same = passes.map((pass) => pass[index] ?? node);
    switch (node.kind) {
      case "step": {
        const ran = same.flatMap((pass, passIndex) =>
          pass.kind === "step" && pass.step.status !== "skipped"
            ? [
                {
                  ...pass.step,
                  id: `${pass.step.id}#${passIndex}`,
                  label: pass.step.label.replace("…", ` ${passIndex + 1}`),
                  children: [],
                  iterations: [],
                },
              ]
            : [],
        );
        const [earliest] = ran;
        const latest = ran.at(-1);
        if (
          !earliest ||
          !latest ||
          earliest.timing.kind !== "span" ||
          latest.timing.kind !== "span"
        ) {
          return node;
        }
        return {
          kind: "step",
          step: {
            ...latest,
            id: node.step.id,
            label: node.step.label,
            timing: {
              kind: "span",
              startedAt: earliest.timing.startedAt,
              endedAt: latest.timing.endedAt,
            },
            iterations: ran,
          },
        };
      }
      case "end":
        return node;
      case "section":
      case "loop":
        return {
          ...node,
          nodes: foldLoopPasses(same.map((pass) => (pass.kind === node.kind ? pass.nodes : []))),
        };
      case "try":
        return {
          ...node,
          body: foldLoopPasses(same.map((pass) => (pass.kind === "try" ? pass.body : []))),
          catch: foldLoopPasses(same.map((pass) => (pass.kind === "try" ? pass.catch : []))),
          finally: foldLoopPasses(same.map((pass) => (pass.kind === "try" ? pass.finally : []))),
        };
      case "fork":
        return {
          ...node,
          branches: node.branches.map((branch, branchIndex) => ({
            ...branch,
            nodes: foldLoopPasses(
              same.map((pass) =>
                pass.kind === "fork" ? (pass.branches[branchIndex]?.nodes ?? []) : [],
              ),
            ),
          })),
        };
    }
    throw new Error("Unsupported workflow run node.");
  });
}

/**
 * Plays the main path: every condition takes its last branch, side branches are skipped, loops
 * run their body a few times, and the run finishes at the first exit it reaches. Durations are
 * deterministic so screenshots stay stable.
 */
function simulateMainPath(nodes: readonly WorkflowRunNode[], startedAt: number) {
  let clock = startedAt;
  let stepIndex = 0;
  let finished = false;
  // Set by a caught throw: the rest of the try body is skipped and its handler runs.
  let throwing = false;
  let status: WorkflowRunStatus = "complete";

  function skip(node: WorkflowRunNode): WorkflowRunNode {
    switch (node.kind) {
      case "step":
        return { kind: "step", step: skipStep(node.step) };
      case "end":
        return node;
      case "section":
      case "loop":
        return { ...node, nodes: node.nodes.map(skip) };
      case "try":
        return {
          ...node,
          body: node.body.map(skip),
          catch: node.catch.map(skip),
          finally: node.finally.map(skip),
        };
      case "fork":
        return {
          ...node,
          branches: node.branches.map((branch) => ({ ...branch, nodes: branch.nodes.map(skip) })),
        };
    }
    throw new Error("Unsupported workflow run node.");
  }

  function skipStep(step: WorkflowRunStep): WorkflowRunStep {
    return { ...step, status: "skipped", children: step.children.map(skipStep) };
  }

  function runStep(step: WorkflowRunStep): WorkflowRunStep {
    const duration =
      step.activity === "wait"
        ? 6_000 + ((stepIndex * 1_913) % 4_000)
        : 400 + ((stepIndex * 737) % 2_600);
    stepIndex += 1;
    const startedAtStep = clock;
    const children = step.children.map(runStep);
    clock = Math.max(clock, startedAtStep + duration);
    return {
      ...step,
      status: "completed",
      attempts: { count: 1, max: 1 },
      timing: { kind: "span", startedAt: startedAtStep, endedAt: clock },
      children,
    };
  }

  function run(sequence: readonly WorkflowRunNode[]): WorkflowRunNode[] {
    return sequence.map((node): WorkflowRunNode => {
      if (finished || throwing) {
        return skip(node);
      }
      switch (node.kind) {
        case "step":
          return { kind: "step", step: runStep(node.step) };
        case "end":
          if (node.end.reason === "caught") {
            throwing = true;
          } else {
            finished = true;
            status = node.end.reason === "error" ? "errored" : "complete";
          }
          return node;
        case "section":
          return { ...node, nodes: run(node.nodes) };
        case "loop": {
          const passes = [run(node.nodes)];
          while (passes.length < LOOP_PASSES && !finished && !throwing) {
            passes.push(run(node.nodes));
          }
          return { ...node, nodes: foldLoopPasses(passes) };
        }
        case "try": {
          const body = run(node.body);
          const caught = throwing;
          throwing = false;
          const handler = caught ? run(node.catch) : node.catch.map(skip);
          // Finally runs even when the body or handler already returned.
          const finishedBefore = finished;
          finished = false;
          const cleanup = run(node.finally);
          finished ||= finishedBefore;
          return { ...node, body, catch: handler, finally: cleanup };
        }
        case "fork": {
          if (node.runs === "one") {
            return {
              ...node,
              branches: node.branches.map((branch, index) =>
                index === node.branches.length - 1
                  ? { ...branch, nodes: run(branch.nodes) }
                  : { ...branch, nodes: branch.nodes.map(skip) },
              ),
            };
          }
          // Parallel branches all start together; the fork finishes with its slowest branch.
          const forkStart = clock;
          let forkEnd = clock;
          const branches = node.branches.map((branch) => {
            clock = forkStart;
            const nodes = run(branch.nodes);
            forkEnd = Math.max(forkEnd, clock);
            return { ...branch, nodes };
          });
          clock = forkEnd;
          return { ...node, branches };
        }
      }
      throw new Error("Unsupported workflow run node.");
    });
  }

  return { nodes: run(nodes), endedAt: clock, status };
}

function GraphFrame({ path, source, run }: { path: string; source: string; run: FixtureRun }) {
  const projected = useMemo(() => {
    const { graph } = visualizeWorkflowSource(path, source);
    const workflow = graph.nodes.find((node) => node.kind === "workflow");
    if (!workflow) {
      throw new Error(`No workflow in ${path}.`);
    }
    const nodes = workflowRunNodesFromGraph(graph, workflow.id, () => unstartedRuntime);
    return { title: workflow.name, nodes, diagnostics: graph.diagnostics.length };
  }, [path, source]);
  const simulated = useMemo(() => simulateMainPath(projected.nodes, T0), [projected.nodes]);

  return run === "simulated" ? (
    <Frame
      title={projected.title}
      status={simulated.status}
      trigger="automation event"
      createdAt={T0 - 320}
      startedAt={T0}
      endedAt={simulated.endedAt}
      nodes={simulated.nodes}
      events={[]}
      diagnostics={projected.diagnostics}
    />
  ) : (
    <Frame
      title={projected.title}
      status="active"
      trigger="automation event"
      createdAt={RECENTLY}
      startedAt={null}
      endedAt={null}
      nodes={projected.nodes}
      events={[]}
      diagnostics={projected.diagnostics}
    />
  );
}

function fixtureStory(name: string) {
  const fixture = WORKFLOW_VISUALIZER_FIXTURES.find(
    ([path]) => path === `automations/${name}.workflow.js`,
  );
  if (!fixture) {
    throw new Error(`Missing workflow visualizer fixture ${name}.`);
  }
  const [path, source] = fixture;
  return {
    name: `Fixture: ${name}`,
    args: { run: "simulated" satisfies FixtureRun },
    argTypes: { run: { control: "inline-radio", options: ["simulated", "not started"] } },
    render: ({ run }: { run: FixtureRun }) => <GraphFrame path={path} source={source} run={run} />,
  };
}

export const TelegramUserLinking = fixtureStory("telegram-user-linking");
export const TelegramUserPiLinking = fixtureStory("telegram-user-pi-linking");
export const PiDefaultAgentConfigure = fixtureStory("pi-default-agent-configure");
export const TelegramTestCommand = fixtureStory("telegram-test-command");
export const Reson8TranscribeOgaUpload = fixtureStory("reson8-transcribe-oga-upload-v2");
export const WorkspaceFileInitialization = fixtureStory("workspace-file-initialization");

// The fixture corpus has no loops or parallel groups, so this source covers them.
const loopsAndParallelSource = `defineWorkflow({ name: "nightly-orders" }, async (event, step) => {
  const orders = await step.do("pull orders", async () => source.pull());
  await Promise.all([
    step.do("prepare orders", async () => orders.prepare()),
    step.do("refresh daily dims", async () => dims.refresh()),
  ]);
  for (const region of event.payload.regions) {
    await step.do("load region " + region, async () => regions.load(region));
    await step.sleep("cool down", "2 seconds");
  }
  const counts = await step.do("count rows", async () => orders.count());
  if (counts.ok) {
    await step.do("promote to prod", async () => orders.promote());
  } else {
    await step.do("quarantine", async () => orders.quarantine());
  }
  await step.do("record summary", async () => summary.record());
  return { promoted: counts.ok };
});
`;

export const LoopsAndParallel = {
  name: "Source: loops and parallel",
  args: { run: "simulated" satisfies FixtureRun },
  argTypes: { run: { control: "inline-radio", options: ["simulated", "not started"] } },
  render: ({ run }: { run: FixtureRun }) => (
    <GraphFrame
      path="automations/nightly-orders.workflow.js"
      source={loopsAndParallelSource}
      run={run}
    />
  ),
};

// An outer loop whose body is only an inner loop runs no step of its own, so its header says
// whether it ran rather than counting its iterations.
const nestedLoopsSource = `defineWorkflow({ name: "import-sheets" }, async (event, step) => {
  for (const sheet of event.payload.sheets) {
    for (const row of sheet.rows) {
      await step.do("import row " + row.id, async () => rows.import(row));
    }
  }
  await step.do("report", async () => report.send());
});
`;

export const NestedLoops = {
  name: "Source: nested loops",
  args: { run: "simulated" satisfies FixtureRun },
  argTypes: { run: { control: "inline-radio", options: ["simulated", "not started"] } },
  render: ({ run }: { run: FixtureRun }) => (
    <GraphFrame path="automations/import-sheets.workflow.js" source={nestedLoopsSource} run={run} />
  ),
};

// A batched mirror that is part way through its loop: one batch needed a retry, and the newest
// batch is still downloading.
const mirrorSource = `export default defineWorkflow({ name: "kc-initial-mirror" }, async (event, step) => {
  const m = await import("/workspace/kc/scripts/kc-sync.js");
  const plan = await step.do("pin main snapshot", () => m.prepare());
  for (let i = 0; i < plan.count; i += 8) {
    await step.do(
      "download files " + i,
      { retries: { limit: 2, delay: "3 seconds", backoff: "exponential" } },
      () => m.downloadBatch(plan.sha, i, 8),
    );
  }
  return await step.do("publish verified snapshot", () => m.publish(plan.sha));
});
`;

function mirrorBatches(startedAt: number, count: number): WorkflowRunStepIteration[] {
  let clock = startedAt;
  return Array.from({ length: count }, (_, index) => {
    const retried = index === 2;
    const duration = 3_100 + ((index * 1_301) % 2_400) + (retried ? 3_000 : 0);
    const batchStart = clock;
    const running = index === count - 1;
    clock += duration + 150;
    return {
      id: `download-${index}`,
      label: `download files ${index * 8}`,
      status: running ? "running" : "completed",
      attempts: { count: retried ? 2 : 1, max: 3 },
      detail: null,
      timing: {
        kind: "span",
        startedAt: batchStart,
        endedAt: running ? null : batchStart + duration,
      },
    };
  });
}

function MirrorFrame({ batches }: { batches: number }) {
  // The run is live, so it is laid out relative to when the story loads.
  const createdAt = useMemo(() => Date.now() - 2_000 - batches * 4_600, [batches]);
  const projected = useMemo(() => {
    const { graph } = visualizeWorkflowSource(
      "automations/kc-initial-mirror.workflow.js",
      mirrorSource,
    );
    const workflow = graph.nodes.find((node) => node.kind === "workflow");
    if (!workflow) {
      throw new Error("No workflow in the mirror source.");
    }
    const [first, ...rest] = mirrorBatches(createdAt + 1_400, batches);
    return workflowRunNodesFromGraph(graph, workflow.id, (node): WorkflowRunStepRuntime => {
      if (node.label === "pin main snapshot") {
        return {
          kind: "single",
          status: "completed",
          attempts: { count: 1, max: 1 },
          timing: { kind: "span", startedAt: createdAt + 200, endedAt: createdAt + 1_300 },
          detail: null,
        };
      }
      if (node.nameTemplate && first) {
        return { kind: "repeated", iterations: [first, ...rest] };
      }
      return unstartedRuntime;
    });
  }, [batches, createdAt]);

  return (
    <Frame
      title="kc-initial-mirror"
      status="active"
      trigger="manual"
      createdAt={createdAt}
      startedAt={createdAt + 120}
      endedAt={null}
      nodes={projected}
      events={[]}
      diagnostics={0}
    />
  );
}

export const LoopInProgress = {
  name: "Loop in progress",
  args: { batches: 7 },
  argTypes: { batches: { control: { type: "range", min: 1, max: 40 } } },
  render: ({ batches }: { batches: number }) => <MirrorFrame batches={batches} />,
};
