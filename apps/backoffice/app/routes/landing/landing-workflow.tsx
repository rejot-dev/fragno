"use client";

import { Tabs } from "@base-ui/react/tabs";
import { Button } from "@fragno-private/design-system/button";
import { Field } from "@fragno-private/design-system/field";
import { Icon } from "@fragno-private/design-system/icon";
import { Input } from "@fragno-private/design-system/input";
import { UnderlineTab, UnderlineTabList } from "@fragno-private/design-system/underline-tabs";
import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";

import { visualizeWorkflowSource, type StepNode } from "@fragno-dev/workflow-visualizer-tokens";

import type { ResolvedWorkflowRuntimeToolCall } from "@/fragno/runtime-tools/workflow-catalog";
import { ScriptWorkflowGraph } from "@/routes/backoffice/automations/script-view/workflow-graph";
import type {
  ScriptWorkflowRun,
  WorkflowStepRunState,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import configureTelegramWorkflowSource from "../../../content/landing/configure-telegram.workflow.js?raw";

const EMPTY_WORKFLOW_RUNTIME_TOOL_CALLS: ReadonlyMap<
  string,
  readonly ResolvedWorkflowRuntimeToolCall[]
> = new Map();

type ConfigureTelegramWorkflowPresentation = {
  visualization: ReturnType<typeof visualizeWorkflowSource>;
  requestBotTokenStepId: string;
  waitForCredentialsStepId: string;
  configureTelegramStepId: string;
  verifyTelegramStepId: string;
};

let cachedConfigureTelegramWorkflowPresentation: ConfigureTelegramWorkflowPresentation | null =
  null;

const TELEGRAM_SETUP_RESULT = {
  $ui: {
    version: 1,
    state: { response: { botToken: "" } },
    spec: {
      root: "form",
      elements: {
        form: {
          type: "Stack",
          props: { gap: "md" },
          children: ["heading", "description", "botToken", "submit"],
        },
        heading: {
          type: "Heading",
          props: { text: "Set up Telegram", level: 2 },
          children: [],
        },
        description: {
          type: "Text",
          props: {
            text: "Enter your Telegram bot token so automations can message your team.",
            tone: "muted",
          },
          children: [],
        },
        botToken: {
          type: "TextInput",
          props: {
            label: "Telegram bot token",
            value: { $bindState: "/response/botToken" },
            description: "Your token is handled as a secret and is not shown in the setup result.",
            required: true,
            secret: true,
          },
          children: [],
        },
        submit: {
          type: "WorkflowEventButton",
          props: {
            label: "Configure Telegram",
            eventType: "telegram-credentials",
            payload: { $state: "/response" },
            variant: "primary",
          },
          children: [],
        },
      },
    },
  },
};

const ACTIVITY_ITEMS = [
  { action: "Skill loaded", detail: "configuring-integrations" },
  { action: "read", detail: "/static/codemode/providers/integrations.d.ts" },
  { action: "write", detail: "automations/configure-telegram.workflow.js" },
] as const;

const DISPLAY_OPTIONS = [
  { id: "ui", label: "UI", icon: "layout" },
  { id: "flow", label: "Flow", icon: "list" },
  { id: "code", label: "Code", icon: "code" },
] as const;

type LandingWorkflowDisplay = (typeof DISPLAY_OPTIONS)[number]["id"];
type DemoExecutionPhase =
  | "waiting"
  | "submitted"
  | "empty-error"
  | "configuring"
  | "verifying"
  | "complete";

function getConfigureTelegramWorkflowPresentation(): ConfigureTelegramWorkflowPresentation {
  if (cachedConfigureTelegramWorkflowPresentation) {
    return cachedConfigureTelegramWorkflowPresentation;
  }

  const visualization = visualizeWorkflowSource(
    "configure-telegram.workflow.js",
    configureTelegramWorkflowSource,
    { fallbackName: "configure-telegram" },
  );
  function findStepNodeId(matches: (step: StepNode) => boolean, description: string): string {
    const step = visualization.graph.nodes.find(
      (node): node is StepNode => node.kind === "step" && matches(node),
    );
    if (!step) {
      throw new Error(`Configure Telegram workflow is missing the ${description} step.`);
    }
    return step.id;
  }

  cachedConfigureTelegramWorkflowPresentation = {
    visualization,
    requestBotTokenStepId: findStepNodeId(
      (step) => step.stepType === "do" && step.label === "request Telegram bot token",
      "request Telegram bot token",
    ),
    waitForCredentialsStepId: findStepNodeId(
      (step) => step.stepType === "waitForEvent" && step.meta.eventType === "telegram-credentials",
      "wait for telegram-credentials",
    ),
    configureTelegramStepId: findStepNodeId(
      (step) => step.stepType === "do" && step.label === "configure Telegram",
      "configure Telegram",
    ),
    verifyTelegramStepId: findStepNodeId(
      (step) => step.stepType === "do" && step.label === "verify Telegram",
      "verify Telegram",
    ),
  };
  return cachedConfigureTelegramWorkflowPresentation;
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

function createConfigureTelegramRun(
  phase: DemoExecutionPhase,
  presentation: ConfigureTelegramWorkflowPresentation,
): ScriptWorkflowRun {
  const {
    requestBotTokenStepId,
    waitForCredentialsStepId,
    configureTelegramStepId,
    verifyTelegramStepId,
  } = presentation;
  const stepStatesByNodeId = new Map<string, WorkflowStepRunState>([
    [requestBotTokenStepId, completedStepState(TELEGRAM_SETUP_RESULT)],
  ]);

  if (phase === "waiting" || phase === "submitted") {
    stepStatesByNodeId.set(waitForCredentialsStepId, {
      status: "waiting",
      attempts: 1,
      waitEventType: "telegram-credentials",
      emissionCount: 0,
      current: true,
    });
  } else {
    stepStatesByNodeId.set(
      waitForCredentialsStepId,
      completedStepState({ eventType: "telegram-credentials" }),
    );
  }

  if (phase === "configuring") {
    stepStatesByNodeId.set(configureTelegramStepId, activeStepState());
  }
  if (phase === "verifying" || phase === "complete") {
    stepStatesByNodeId.set(configureTelegramStepId, completedStepState(undefined));
  }
  if (phase === "verifying") {
    stepStatesByNodeId.set(verifyTelegramStepId, activeStepState());
  }
  if (phase === "complete") {
    stepStatesByNodeId.set(verifyTelegramStepId, completedStepState(undefined));
  }

  return {
    id: "landing-configure-telegram-run",
    instanceId: "landing-configure-telegram-instance",
    workflowName: "configure-telegram",
    instanceWorkflowName: "configure-telegram",
    status:
      phase === "waiting" || phase === "submitted"
        ? "waiting"
        : phase === "empty-error"
          ? "errored"
          : phase === "complete"
            ? "complete"
            : "active",
    output: phase === "complete" ? { connection: "telegram", status: "ready" } : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:04.000Z",
    waitingEventTypes: phase === "waiting" || phase === "submitted" ? ["telegram-credentials"] : [],
    workflowEvents: [],
    stepStatesByNodeId,
    stepExecutionsByNodeId: new Map(),
    unmappedRuntimeSteps: [],
    hasUnmappedCurrentStep: false,
  };
}

/** Shows how a request becomes inspectable UI, flow, and executable workflow source. */
export function LandingWorkflow() {
  const [display, setDisplay] = useState<LandingWorkflowDisplay>("ui");
  const [botToken, setBotToken] = useState("");
  const [executionPhase, setExecutionPhase] = useState<DemoExecutionPhase>("waiting");
  const executionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const flowPanelRef = useRef<HTMLDivElement>(null);
  const workflowPresentation =
    display === "flow" ? getConfigureTelegramWorkflowPresentation() : null;

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

  function submitBotToken(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    clearExecutionTimers();
    setExecutionPhase("submitted");
    setDisplay("flow");

    if (!botToken.trim()) {
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
      setBotToken("");
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
            <Icon name="box" className="size-3.5 text-[var(--bo-accent)]" />
            <span className="text-[10px] font-bold tracking-[0.18em] uppercase">Conversation</span>
          </header>

          <div className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
            <div className="ml-auto max-w-[88%] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-3">
              <p className="text-sm leading-6 text-[var(--bo-fg)]">
                Help me connect our Telegram bot.
              </p>
            </div>

            <div className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] px-4 py-3">
              <p className="text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                Thinking
              </p>
              <p className="mt-2 text-xs leading-5 text-[var(--bo-muted)]">
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
                      <Icon name="check" className="size-2.5" />
                    </span>
                    <span className="truncate">{item.action}</span>
                  </span>
                  <code className="truncate font-mono text-[10px] text-[var(--bo-muted)]">
                    {item.detail}
                  </code>
                </div>
              ))}
            </div>

            <div className="max-w-[92%] py-2">
              <p className="text-sm leading-6 text-[var(--bo-fg)]">
                I generated a UI-based workflow that requests the bot token, configures the Telegram
                connection, and verifies the result before completing.
              </p>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col max-[820px]:h-[620px]">
          <header className="flex h-12 items-stretch justify-between gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <Icon name="file-text" className="size-3.5 shrink-0 text-[var(--bo-accent)]" />
              <span className="truncate font-mono text-[9px] font-semibold tracking-[0.06em] text-[var(--bo-muted)]">
                configure-telegram.workflow.js
              </span>
            </div>

            <Tabs.Root
              value={display}
              onValueChange={(value: LandingWorkflowDisplay) => {
                selectDisplay(value);
              }}
              className="flex items-stretch"
            >
              {/* The panels are rendered outside Tabs.Root, so the tabs keep their explicit ids and
                  aria-controls to stay linked to them. */}
              <UnderlineTabList aria-label="Workflow representation" className="-mb-px shadow-none">
                {DISPLAY_OPTIONS.map(({ id, label, icon }) => (
                  <UnderlineTab
                    key={id}
                    value={id}
                    id={`landing-workflow-${id}-tab`}
                    aria-controls={`landing-workflow-${id}-panel`}
                  >
                    <Icon name={icon} />
                    {label}
                  </UnderlineTab>
                ))}
              </UnderlineTabList>
            </Tabs.Root>
          </header>

          <div className="min-h-0 flex-1">
            {display === "ui" ? (
              <LandingGeneratedUi
                botToken={botToken}
                disabled={executionPhase !== "waiting"}
                onBotTokenChange={setBotToken}
                onSubmit={submitBotToken}
              />
            ) : null}
            {workflowPresentation ? (
              <LandingWorkflowGraph
                executionPhase={executionPhase}
                panelRef={flowPanelRef}
                selectedRun={createConfigureTelegramRun(executionPhase, workflowPresentation)}
                visualization={workflowPresentation.visualization}
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
  botToken,
  disabled,
  onBotTokenChange,
  onSubmit,
}: {
  botToken: string;
  disabled: boolean;
  onBotTokenChange: (botToken: string) => void;
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
        configure-telegram
      </h3>
      <form
        onSubmit={onSubmit}
        className="border border-[color:var(--bo-waiting)] bg-[var(--bo-panel)] p-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[color:var(--bo-border)] pb-3">
          <p className="text-sm font-medium text-[var(--bo-fg)]">request Telegram bot token</p>
          <span className="flex items-center gap-1.5 border border-[color:var(--bo-waiting)] bg-[var(--bo-waiting-bg)] px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.14em] text-[var(--bo-waiting)] uppercase">
            <span className="size-1.5 rounded-full bg-[var(--bo-waiting)]" aria-hidden="true" />
            Waiting
          </span>
        </div>

        <div className="mt-4 space-y-4">
          <h2 className="text-2xl font-semibold tracking-[-0.035em] text-[var(--bo-fg)]">
            Set up Telegram
          </h2>
          <p className="text-sm leading-6 text-[var(--bo-muted)]">
            Enter your Telegram bot token so automations can message your team.
          </p>
          <Field
            density="compact"
            label="Telegram bot token"
            description="Your token is handled as a secret and is not shown in the setup result."
            required
          >
            <Input
              density="compact"
              type="password"
              value={botToken}
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => {
                onBotTokenChange(event.target.value);
              }}
              className="w-full"
            />
          </Field>
          <Button type="submit" variant="solid" disabled={disabled}>
            Configure Telegram
          </Button>
        </div>
      </form>
    </div>
  );
}

function LandingWorkflowGraph({
  executionPhase,
  panelRef,
  selectedRun,
  visualization,
}: {
  executionPhase: DemoExecutionPhase;
  panelRef: RefObject<HTMLDivElement | null>;
  selectedRun: ScriptWorkflowRun;
  visualization: ConfigureTelegramWorkflowPresentation["visualization"];
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
          <Icon name="x-octagon" className="size-4 shrink-0" />
          Workflow stopped: a Telegram bot token is required.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ScriptWorkflowGraph
          visualization={visualization}
          detailMode="simple"
          runtimeToolCallsByStepId={EMPTY_WORKFLOW_RUNTIME_TOOL_CALLS}
          selectedRun={selectedRun}
          sourceCode={configureTelegramWorkflowSource}
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
        <code>{configureTelegramWorkflowSource}</code>
      </pre>
    </div>
  );
}
