import type { LofiSqliteClient } from "@fragno-dev/lofi/sqlite";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import {
  ChatWorkflow,
  ChatWorkflowInputRequest,
  type ChatWorkflowElement,
  type ChatWorkflowStatus,
} from "@fragno-private/design-system/chat-workflow";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { terminateBackofficeWorkflowRun } from "@/backoffice-ui/workflow-events.client";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { WorkflowRunGeneratedInterface } from "@/components/backoffice/workflow-run-generated-interface";
import { useCurrentAutomationReplica } from "@/fragno/automation/lofi/replica";
import { useWorkflowRunRecords } from "@/routes/backoffice/automations/script-view/use-script-workflow-runs";
import {
  currentWorkflowWaitingEventTypes,
  latestWorkflowRunGeneratedUi,
  workflowRunTime,
  type AutomationWorkflowRun,
  type WorkflowRunGeneratedUi,
  type WorkflowRunReference,
  type WorkflowRunStep,
} from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

// The workflows an agent starts show in the conversation, each as one card in the turn that
// started it. The rest of the thread points at the card: a run waiting for the reader out of view
// asks for them above the composer, and the run's completion event leads back to it.

/** A run whose card is in the thread. */
type SessionRun = {
  name: string;
  /** The step whose interface waits for the reader; null while the run does not ask. */
  inputStep: string | null;
  visible: boolean;
  card: HTMLElement;
  /** Brings the reader to the card, showing what the run is on now. */
  show: () => void;
};

type SessionWorkflows = {
  /** The scope's Automations replica, which runs are read from; null until it opens. */
  replica: LofiSqliteClient | null;
  replicaError: string | null;
  /** Keyed by instance id. */
  runs: ReadonlyMap<string, SessionRun>;
  setRun: (instanceId: string, run: SessionRun | null) => void;
};

const SessionWorkflowsContext = createContext<SessionWorkflows | null>(null);

export function SessionWorkflowsProvider({ children }: { children: ReactNode }) {
  const { replica, error } = useCurrentAutomationReplica();
  const [runs, setRuns] = useState<ReadonlyMap<string, SessionRun>>(() => new Map());
  const setRun = useCallback((instanceId: string, run: SessionRun | null) => {
    setRuns((current) => {
      if (run === null && !current.has(instanceId)) {
        return current;
      }
      const next = new Map(current);
      if (run === null) {
        next.delete(instanceId);
      } else {
        next.set(instanceId, run);
      }
      return next;
    });
  }, []);
  const value = useMemo(
    () => ({ replica, replicaError: error, runs, setRun }),
    [replica, error, runs, setRun],
  );
  return (
    <SessionWorkflowsContext.Provider value={value}>{children}</SessionWorkflowsContext.Provider>
  );
}

function useSessionWorkflows() {
  const workflows = useContext(SessionWorkflowsContext);
  if (workflows === null) {
    throw new Error("Session workflows render inside a SessionWorkflowsProvider.");
  }
  return workflows;
}

/** The run's card when it is in the thread; null while it is not, such as in unloaded history. */
export function useSessionRun(instanceId: string | null): SessionRun | null {
  const { runs } = useSessionWorkflows();
  return instanceId === null ? null : (runs.get(instanceId) ?? null);
}

/** A run the agent started: every interface its steps produced, and the output it ended with. */
export function SessionWorkflow({ run: reference }: { run: WorkflowRunReference }) {
  const { replica, replicaError, setRun } = useSessionWorkflows();
  const { resolvedScope } = useCurrentBackofficeContext();
  const records = useWorkflowRunRecords({
    replica,
    selector: { type: "instance", ...reference },
  });
  const run = records.instances[0] ?? null;
  const steps = useMemo(
    () =>
      run === null
        ? []
        : [...run.workflowSteps].sort(
            (left, right) =>
              workflowRunTime(left.createdAt) - workflowRunTime(right.createdAt) ||
              left.id.localeCompare(right.id),
          ),
    [run],
  );
  const syncError = records.error ?? (replica === null ? replicaError : null);
  const status: ChatWorkflowStatus =
    syncError !== null
      ? { kind: "synchronization-failed", error: `Workflow synchronization failed: ${syncError}` }
      : run === null
        ? { kind: "synchronizing" }
        : workflowStatus(run, steps);
  const name = run === null ? "Workflow" : (run.remoteWorkflowName ?? run.workflowName);
  const elements =
    run === null
      ? []
      : workflowElements(run, steps, (generatedUi) => (
          <WorkflowRunGeneratedInterface
            run={{ ...run, steps }}
            generatedUi={generatedUi}
            resolvedScope={resolvedScope}
            standalone
          />
        ));

  // A new element moves the card on to it, whichever one the reader was looking at.
  const newestId = elements.at(-1)?.id ?? null;
  const [selection, setSelection] = useState<{ id: string; newestId: string | null } | null>(null);
  const selectedId = selection?.newestId === newestId ? selection.id : null;

  const [card, setCard] = useState<HTMLElement | null>(null);
  const visible = useVisible(card);
  const inputStep = status.kind === "waiting-for-input" ? status.step : null;
  useEffect(() => {
    if (card === null) {
      return undefined;
    }
    setRun(reference.instanceId, {
      name,
      inputStep,
      visible,
      card,
      show: () => {
        setSelection(null);
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        card.focus({ preventScroll: true });
      },
    });
    return () => {
      setRun(reference.instanceId, null);
    };
  }, [card, inputStep, name, reference.instanceId, setRun, visible]);

  // The run's row arrives after the tool call returns; until then there is nothing to show.
  if (run === null && syncError === null && !records.isLoading && replica !== null) {
    return null;
  }

  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  return (
    <ChatWorkflow
      ref={setCard}
      name={name}
      status={status}
      elements={elements}
      selectedId={selectedId}
      onSelect={(id) => {
        setSelection(id === null ? null : { id, newestId });
      }}
      onStop={
        run !== null && stoppable(run)
          ? () =>
              terminateBackofficeWorkflowRun({
                scope: runtimeScope,
                workflowName: run.workflowName,
                instanceId: run.instanceId,
              })
          : null
      }
    />
  );
}

/**
 * The interfaces the run's steps returned, oldest first, then its output. An output that returns
 * the last step's interface as it is would repeat it, so that step stands as the output instead.
 */
function workflowElements(
  run: AutomationWorkflowRun,
  steps: readonly WorkflowRunStep[],
  render: (generatedUi: WorkflowRunGeneratedUi<WorkflowRunStep>) => ReactNode,
): ChatWorkflowElement[] {
  const interfaceSteps = steps.filter(
    (step) =>
      step.status === "completed" && parseBackofficeUiResult(step.result).kind !== "ordinary",
  );
  const output = parseBackofficeUiResult(run.output);
  const lastStep = interfaceSteps.at(-1);
  const outputRepeatsLastStep =
    output.kind !== "ordinary" &&
    lastStep !== undefined &&
    JSON.stringify(lastStep.result) === JSON.stringify(run.output);

  const elements = interfaceSteps.map(
    (step): ChatWorkflowElement => ({
      id: step.id,
      label: step.name,
      kind: outputRepeatsLastStep && step === lastStep ? "output" : "step",
      content: render({ type: "step", step }),
    }),
  );
  return output.kind === "ordinary" || outputRepeatsLastStep
    ? elements
    : [
        ...elements,
        {
          id: "output",
          label: "Result",
          kind: "output",
          content: render({ type: "output", parsed: output }),
        },
      ];
}

/**
 * Where the run stands. It waits for the reader when its newest interface is a step's, as the
 * dashboard's runs waiting for input do.
 */
function workflowStatus(
  run: AutomationWorkflowRun,
  steps: readonly WorkflowRunStep[],
): ChatWorkflowStatus {
  switch (run.status) {
    case "active":
      // A step is recorded once it settles, so the one running now has no record yet.
      return { kind: "running", step: null };
    case "waiting": {
      const generatedUi = latestWorkflowRunGeneratedUi({ output: run.output, steps });
      if (currentWorkflowWaitingEventTypes(steps).length > 0 && generatedUi?.type === "step") {
        return { kind: "waiting-for-input", step: generatedUi.step.name };
      }
      return { kind: "waiting", step: latestStepName(steps, "waiting") };
    }
    case "paused":
      return { kind: "waiting", step: "Paused" };
    case "complete":
      return { kind: "complete" };
    case "errored":
      return {
        kind: "failed",
        step: latestStepName(steps, "errored"),
        error: run.errorMessage ?? run.errorName ?? "The run failed.",
      };
    case "terminated":
      return { kind: "stopped" };
  }
  throw new Error("Unsupported workflow run status.", { cause: run.status satisfies never });
}

function stoppable(run: AutomationWorkflowRun) {
  return run.status === "active" || run.status === "waiting" || run.status === "paused";
}

function latestStepName(steps: readonly WorkflowRunStep[], status: WorkflowRunStep["status"]) {
  return [...steps].reverse().find((step) => step.status === status)?.name ?? null;
}

// The composer covers the bottom of the thread, so a card behind it does not count as seen.
const COMPOSER_HEIGHT_PX = 200;

function useVisible(element: HTMLElement | null) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (element === null) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry?.isIntersecting ?? true);
      },
      { rootMargin: `0px 0px -${COMPOSER_HEIGHT_PX}px 0px` },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return visible;
}

/** Above the composer: the runs waiting for the reader whose cards are out of view. */
export function SessionWorkflowInputRequests() {
  const { runs } = useSessionWorkflows();
  const waiting = [...runs]
    .flatMap(([instanceId, run]) =>
      run.inputStep !== null && !run.visible ? [{ instanceId, run, step: run.inputStep }] : [],
    )
    .sort((left, right) =>
      left.run.card.compareDocumentPosition(right.run.card) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    );
  return (
    <ChatWorkflowInputRequest
      requests={waiting.map(({ instanceId, run, step }) => ({
        id: instanceId,
        name: run.name,
        step,
      }))}
      onShow={(instanceId) => {
        runs.get(instanceId)?.show();
      }}
    />
  );
}
