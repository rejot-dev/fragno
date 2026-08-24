"use client";

import { Check, Code2, FileCode2, ListTree, OctagonX, PanelsTopLeft, Puzzle } from "lucide-react";
import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";

import { visualizeWorkflowSource, type StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";
import { ScriptWorkflowGraph } from "@/routes/backoffice/automations/script-view/workflow-graph";
import type {
  ScriptWorkflowRun,
  WorkflowStepRunState,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import configureReson8WorkflowSource from "../../../content/landing/configure-reson8.workflow.js?raw";

const EMPTY_WORKFLOW_RUNTIME_TOOL_CALLS: ReadonlyMap<
  string,
  readonly ResolvedWorkflowRuntimeToolCall[]
> = new Map();

const configureReson8Visualization = visualizeWorkflowSource(
  "configure-reson8.workflow.js",
  configureReson8WorkflowSource,
  { fallbackName: "configure-reson8" },
);

const RESON8_SETUP_RESULT = {
  $ui: {
    version: 1,
    state: { response: { apiKey: "" } },
    spec: {
      root: "form",
      elements: {
        form: {
          type: "Stack",
          props: { gap: "md" },
          children: ["heading", "description", "apiKey", "submit"],
        },
        heading: {
          type: "Heading",
          props: { text: "Set up Reson8", level: 2 },
          children: [],
        },
        description: {
          type: "Text",
          props: {
            text: "Enter your Reson8 API key to enable speech-to-text for this organisation.",
            tone: "muted",
          },
          children: [],
        },
        apiKey: {
          type: "TextInput",
          props: {
            label: "Reson8 API key",
            value: { $bindState: "/response/apiKey" },
            description: "Your key is handled as a secret and is not shown in the setup result.",
            required: true,
            secret: true,
          },
          children: [],
        },
        submit: {
          type: "WorkflowEventButton",
          props: {
            label: "Configure Reson8",
            eventType: "reson8-credentials",
            payload: { $state: "/response" },
            variant: "primary",
          },
          children: [],
        },
      },
    },
  },
};

const requestApiKeyStepId = findWorkflowStepNodeId(
  (step) => step.stepType === "do" && step.label === "request Reson8 API key",
  "request Reson8 API key",
);
const waitForCredentialsStepId = findWorkflowStepNodeId(
  (step) => step.stepType === "waitForEvent" && step.meta.eventType === "reson8-credentials",
  "wait for reson8-credentials",
);
const configureReson8StepId = findWorkflowStepNodeId(
  (step) => step.stepType === "do" && step.label === "configure Reson8",
  "configure Reson8",
);
const verifyReson8StepId = findWorkflowStepNodeId(
  (step) => step.stepType === "do" && step.label === "verify Reson8",
  "verify Reson8",
);

const ACTIVITY_ITEMS = [
  { action: "Skill loaded", detail: "configuring-connections" },
  { action: "Skill loaded", detail: "reson8-connection" },
  { action: "read", detail: "/static/codemode/providers/connections.d.ts" },
  { action: "created", detail: "automations/configure-reson8.workflow.js" },
] as const;

const DISPLAY_OPTIONS = [
  { id: "ui", label: "UI", icon: PanelsTopLeft },
  { id: "flow", label: "Flow", icon: ListTree },
  { id: "code", label: "Code", icon: Code2 },
] as const;

type LandingWorkflowDisplay = (typeof DISPLAY_OPTIONS)[number]["id"];
type DemoExecutionPhase =
  | "waiting"
  | "submitted"
  | "empty-error"
  | "configuring"
  | "verifying"
  | "complete";

function findWorkflowStepNodeId(matches: (step: StepNode) => boolean, description: string): string {
  const step = configureReson8Visualization.graph.nodes.find(
    (node): node is StepNode => node.kind === "step" && matches(node),
  );
  if (!step) {
    throw new Error(`Configure Reson8 workflow is missing the ${description} step.`);
  }
  return step.id;
}

function completedStepState(result: unknown): WorkflowStepRunState {
  return {
    status: "completed",
    attempts: 1,
    completedAt: "2026-01-01T00:00:01.000Z",
    result,
    emissionCount: 0,
    current: false,
  };
}

function activeStepState(): WorkflowStepRunState {
  return {
    status: "active",
    attempts: 1,
    emissionCount: 0,
    current: true,
  };
}

function createConfigureReson8Run(phase: DemoExecutionPhase): ScriptWorkflowRun {
  const stepStatesByNodeId = new Map<string, WorkflowStepRunState>([
    [requestApiKeyStepId, completedStepState(RESON8_SETUP_RESULT)],
  ]);

  if (phase === "waiting" || phase === "submitted") {
    stepStatesByNodeId.set(waitForCredentialsStepId, {
      status: "waiting",
      attempts: 1,
      waitEventType: "reson8-credentials",
      emissionCount: 0,
      current: true,
    });
  } else {
    stepStatesByNodeId.set(
      waitForCredentialsStepId,
      completedStepState({ eventType: "reson8-credentials" }),
    );
  }

  if (phase === "configuring") {
    stepStatesByNodeId.set(configureReson8StepId, activeStepState());
  }
  if (phase === "verifying" || phase === "complete") {
    stepStatesByNodeId.set(configureReson8StepId, completedStepState(undefined));
  }
  if (phase === "verifying") {
    stepStatesByNodeId.set(verifyReson8StepId, activeStepState());
  }
  if (phase === "complete") {
    stepStatesByNodeId.set(verifyReson8StepId, completedStepState(undefined));
  }

  return {
    id: "landing-configure-reson8-run",
    instanceId: "landing-configure-reson8-instance",
    workflowName: "configure-reson8",
    instanceWorkflowName: "configure-reson8",
    status:
      phase === "waiting" || phase === "submitted"
        ? "waiting"
        : phase === "empty-error"
          ? "errored"
          : phase === "complete"
            ? "complete"
            : "active",
    output: phase === "complete" ? { connection: "reson8", status: "ready" } : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:04.000Z",
    waitingEventTypes: phase === "waiting" || phase === "submitted" ? ["reson8-credentials"] : [],
    workflowEvents: [],
    stepStatesByNodeId,
    unmappedRuntimeSteps: [],
    hasUnmappedCurrentStep: false,
  };
}

/** Shows how a request becomes inspectable UI, flow, and executable workflow source. */
export function LandingWorkflow() {
  const [display, setDisplay] = useState<LandingWorkflowDisplay>("ui");
  const [apiKey, setApiKey] = useState("");
  const [executionPhase, setExecutionPhase] = useState<DemoExecutionPhase>("waiting");
  const executionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const flowPanelRef = useRef<HTMLDivElement>(null);
  const selectedRun = createConfigureReson8Run(executionPhase);

  function clearExecutionTimers() {
    for (const timer of executionTimers.current) {
      clearTimeout(timer);
    }
    executionTimers.current = [];
  }

  function scheduleExecutionPhase(phase: DemoExecutionPhase, delay: number) {
    executionTimers.current.push(
      setTimeout(() => {
        setExecutionPhase(phase);
      }, delay),
    );
  }

  function submitApiKey(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    clearExecutionTimers();
    setExecutionPhase("submitted");
    setDisplay("flow");

    if (!apiKey.trim()) {
      scheduleExecutionPhase("empty-error", 500);
      return;
    }

    scheduleExecutionPhase("configuring", 500);
    scheduleExecutionPhase("verifying", 1_000);
    scheduleExecutionPhase("complete", 1_500);
  }

  function selectDisplay(nextDisplay: LandingWorkflowDisplay) {
    if (nextDisplay === "ui" && executionPhase !== "waiting") {
      clearExecutionTimers();
      setApiKey("");
      setExecutionPhase("waiting");
    }
    setDisplay(nextDisplay);
  }

  useEffect(() => clearExecutionTimers, []);

  useEffect(() => {
    if (display !== "flow" || executionPhase !== "complete") {
      return;
    }
    const output = flowPanelRef.current?.querySelector<HTMLDetailsElement>(
      "[data-workflow-final-return-output] details",
    );
    if (output) {
      output.open = true;
    }
  }, [display, executionPhase]);

  return (
    <section className="mx-auto w-full max-w-[1180px] px-5 pb-20 sm:px-8 lg:px-12 lg:pb-28">
      <div className="grid min-h-[620px] grid-cols-[minmax(310px,0.42fr)_minmax(0,0.58fr)] overflow-hidden bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)] outline outline-1 -outline-offset-1 outline-black/10 max-[820px]:grid-cols-1 dark:outline-white/10">
        <div className="flex min-h-0 flex-col border-r border-[color:var(--bo-border)] max-[820px]:border-r-0 max-[820px]:border-b">
          <header className="flex h-12 items-center gap-2 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 sm:px-5">
            <Puzzle className="size-3.5 text-[var(--bo-accent)]" aria-hidden="true" />
            <span className="text-[10px] font-bold tracking-[0.18em] uppercase">Conversation</span>
          </header>

          <div className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
            <div className="ml-auto max-w-[88%] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-3">
              <p className="text-sm leading-6 text-[var(--bo-fg)]">
                Help me set up Reson8 for speech-to-text.
              </p>
            </div>

            <div className="border-l-2 border-[color:var(--bo-accent)] px-4 py-2">
              <p className="text-xs leading-5 text-[var(--bo-muted)]">
                I’ll request the credential, configure the connection, and verify it before
                completing.
              </p>
            </div>

            <div className="mt-1 space-y-2">
              {ACTIVITY_ITEMS.map((item) => (
                <div
                  key={`${item.action}:${item.detail}`}
                  className="grid min-h-12 grid-cols-[minmax(92px,0.34fr)_minmax(0,0.66fr)] items-center gap-3 border border-[color:var(--bo-border)] px-3"
                >
                  <span className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-[var(--bo-fg)]">
                    <span className="grid size-4 shrink-0 place-items-center bg-emerald-500/10 text-[var(--bo-live)]">
                      <Check className="size-2.5" aria-hidden="true" />
                    </span>
                    <span className="truncate">{item.action}</span>
                  </span>
                  <code className="truncate font-mono text-[10px] text-[var(--bo-muted)]">
                    {item.detail}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col max-[820px]:h-[620px]">
          <header className="flex h-12 items-stretch justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <FileCode2 className="size-3.5 shrink-0 text-[var(--bo-accent)]" aria-hidden="true" />
              <span className="truncate font-mono text-[9px] font-semibold tracking-[0.06em] text-[var(--bo-muted)]">
                configure-reson8.workflow.js
              </span>
            </div>

            <div role="tablist" aria-label="Workflow representation" className="flex items-stretch">
              {DISPLAY_OPTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  id={`landing-workflow-${id}-tab`}
                  type="button"
                  role="tab"
                  aria-selected={display === id}
                  aria-controls={`landing-workflow-${id}-panel`}
                  onClick={() => {
                    selectDisplay(id);
                  }}
                  className={`flex h-full items-center gap-1.5 border-b-2 px-2 text-[9px] font-semibold tracking-[0.16em] uppercase transition-[border-color,color,scale] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 active:scale-[0.96] sm:px-3 ${
                    display === id
                      ? "border-[color:var(--bo-accent)] text-[var(--bo-fg)]"
                      : "border-transparent text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]"
                  }`}
                >
                  <Icon className="size-3" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </header>

          <div className="min-h-0 flex-1">
            {display === "ui" ? (
              <LandingGeneratedUi
                apiKey={apiKey}
                disabled={executionPhase !== "waiting"}
                onApiKeyChange={setApiKey}
                onSubmit={submitApiKey}
              />
            ) : null}
            {display === "flow" ? (
              <LandingWorkflowGraph
                executionPhase={executionPhase}
                panelRef={flowPanelRef}
                selectedRun={selectedRun}
              />
            ) : null}
            {display === "code" ? <LandingWorkflowCode /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function LandingGeneratedUi({
  apiKey,
  disabled,
  onApiKeyChange,
  onSubmit,
}: {
  apiKey: string;
  disabled: boolean;
  onApiKeyChange: (apiKey: string) => void;
  onSubmit: (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => void;
}) {
  return (
    <div
      id="landing-workflow-ui-panel"
      role="tabpanel"
      aria-labelledby="landing-workflow-ui-tab"
      className="backoffice-scroll h-full overflow-auto bg-[var(--bo-panel-2)] p-4"
    >
      <h3 className="mb-3 px-1 text-[10px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase">
        configure-reson8
      </h3>
      <form
        onSubmit={onSubmit}
        className="border border-[color:var(--bo-waiting)] bg-[var(--bo-panel)] p-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[color:var(--bo-border)] pb-3">
          <p className="text-sm font-medium text-[var(--bo-fg)]">request Reson8 API key</p>
          <span className="flex items-center gap-1.5 border border-[color:var(--bo-waiting)] bg-[var(--bo-waiting-bg)] px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.14em] text-[var(--bo-waiting)] uppercase">
            <span className="size-1.5 rounded-full bg-[var(--bo-waiting)]" aria-hidden="true" />
            Waiting
          </span>
        </div>

        <div className="mt-4 space-y-4">
          <h2 className="text-2xl font-semibold tracking-[-0.035em] text-[var(--bo-fg)]">
            Set up Reson8
          </h2>
          <p className="text-sm leading-6 text-[var(--bo-muted)]">
            Enter your Reson8 API key to enable speech-to-text for this organisation.
          </p>
          <label className="block min-w-0">
            <span className="block text-[10px] font-semibold tracking-[0.08em] text-[var(--bo-fg)]">
              Reson8 API key <span className="text-[var(--bo-failed)]">*</span>
            </span>
            <span className="mt-1 block text-[10px] leading-4 text-[var(--bo-muted-2)]">
              Your key is handled as a secret and is not shown in the setup result.
            </span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => {
                onApiKeyChange(event.target.value);
              }}
              className="mt-2 min-h-10 w-full border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 text-xs text-[var(--bo-fg)] transition-[border-color,box-shadow] duration-150 outline-none focus:border-[color:var(--bo-accent)] focus:shadow-[0_0_0_3px_var(--bo-accent-bg)] disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <button
            type="submit"
            disabled={disabled}
            className="inline-flex min-h-10 items-center justify-center border border-[color:var(--bo-btn-bg)] bg-[var(--bo-btn-bg)] px-4 text-xs font-semibold text-[var(--bo-btn-fg)] transition-[background-color,scale,opacity] duration-150 hover:bg-[var(--bo-btn-bg-hover)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
          >
            Configure Reson8
          </button>
        </div>
      </form>
    </div>
  );
}

function LandingWorkflowGraph({
  executionPhase,
  panelRef,
  selectedRun,
}: {
  executionPhase: DemoExecutionPhase;
  panelRef: RefObject<HTMLDivElement | null>;
  selectedRun: ScriptWorkflowRun;
}) {
  const collapseRequestUi = !["waiting", "submitted"].includes(executionPhase);
  const hasCollapsedRequestUi = useRef(false);

  useEffect(() => {
    const generatedUi = panelRef.current?.querySelector<HTMLElement>(
      "[data-workflow-step-generated-ui]",
    );
    if (!generatedUi) {
      return;
    }
    if (!collapseRequestUi) {
      hasCollapsedRequestUi.current = false;
      for (const animation of generatedUi.getAnimations()) {
        animation.cancel();
      }
      generatedUi.removeAttribute("style");
      return;
    }
    if (hasCollapsedRequestUi.current) {
      generatedUi.style.maxHeight = "0px";
      generatedUi.style.marginTop = "0px";
      generatedUi.style.paddingTop = "0px";
      generatedUi.style.opacity = "0";
      generatedUi.style.overflow = "hidden";
      return;
    }

    hasCollapsedRequestUi.current = true;
    const expandedHeight = generatedUi.getBoundingClientRect().height;
    generatedUi.style.overflow = "hidden";
    generatedUi.animate(
      [
        {
          maxHeight: `${expandedHeight}px`,
          marginTop: "0.75rem",
          paddingTop: "0.75rem",
          opacity: 1,
        },
        {
          maxHeight: "0px",
          marginTop: "0px",
          paddingTop: "0px",
          opacity: 0,
        },
      ],
      { duration: 500, easing: "ease-in-out", fill: "forwards" },
    );
  }, [collapseRequestUi, panelRef]);

  return (
    <div
      ref={panelRef}
      id="landing-workflow-flow-panel"
      role="tabpanel"
      aria-labelledby="landing-workflow-flow-tab"
      className="flex h-full min-w-0 flex-col [--bo-accent-bg:color-mix(in_srgb,var(--bo-blue-4)_24%,var(--bo-panel))] [--bo-accent-fg:var(--bo-blue-1)] [--bo-accent:var(--bo-blue-2)] dark:[--bo-accent-bg:color-mix(in_srgb,var(--bo-blue-1)_20%,var(--bo-panel))] dark:[--bo-accent-fg:var(--bo-blue-4)]"
    >
      {executionPhase === "empty-error" ? (
        <div
          role="alert"
          className="flex shrink-0 animate-[pulse_600ms_ease-out_1] items-center gap-2 border-b border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-4 py-3 text-xs font-semibold text-[var(--bo-failed)]"
        >
          <OctagonX className="size-4 shrink-0" aria-hidden="true" />
          Workflow stopped: a Reson8 API key is required.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ScriptWorkflowGraph
          visualization={configureReson8Visualization}
          detailMode="simple"
          runtimeToolCallsByStepId={EMPTY_WORKFLOW_RUNTIME_TOOL_CALLS}
          selectedRun={selectedRun}
          sourceCode={configureReson8WorkflowSource}
          fillHeight
        />
      </div>
    </div>
  );
}

function LandingWorkflowCode() {
  return (
    <div
      id="landing-workflow-code-panel"
      role="tabpanel"
      aria-labelledby="landing-workflow-code-tab"
      tabIndex={0}
      className="backoffice-scroll h-full overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bo-accent)]"
    >
      <pre className="min-h-full p-4 font-mono text-[11px] leading-5 whitespace-pre-wrap text-[var(--bo-fg)] sm:p-5">
        <code>{configureReson8WorkflowSource}</code>
      </pre>
    </div>
  );
}
