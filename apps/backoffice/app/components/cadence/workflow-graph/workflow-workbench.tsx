/*
 * The workflow workbench — the split-view editor + live graph for a single
 * automation workflow. The textarea re-parses on the server (preview) as you
 * type, the graph reflects unsaved edits while dirty, and saving writes back to
 * the file. It also runs the workflow and highlights step nodes as emissions
 * stream in.
 *
 * Extracted from the workflows route so it can be mounted anywhere a workflow
 * needs to be edited next to its graph — the workflows page, and the exec
 * surface's companion panel (where the Pi agent edits the same files). All
 * mutations post to the workflows route action (`WORKFLOWS_ACTION`), regardless
 * of where the workbench is mounted, so a single server handler backs both.
 */

import { Play, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";

import type { WorkflowGraph, WorkflowInputField } from "@fragno-dev/workflow-visualizer";

import { CadenceButton, CadenceGhostButton, StatusBadge, type Status } from "@/components/cadence";
import { cn } from "@/lib/utils";
import { useWorkflowRun, type RunEmission, type RunStep } from "@/routes/cadence/use-workflow-run";
import type { RunnableEvent, WorkflowSource } from "@/routes/cadence/workflow-graph.server";

import { WorkflowView } from "./workflow-view";

/** The route whose `action` handles preview/save/run, posted to from anywhere. */
export const WORKFLOWS_ACTION = "/workflows";

const PREVIEW_DEBOUNCE_MS = 400;

/**
 * The shape of the workflows route action's responses, as the workbench reads
 * them. Kept permissive (a single bag rather than the precise union) so the
 * workbench stays decoupled from the route module — the `in`/`ok` guards below
 * narrow it at each use site exactly as before.
 */
type WorkflowActionData = {
  ok: boolean;
  error?: string | null;
  graph?: WorkflowGraph;
  intent?: "run";
  instanceId?: string;
  runWorkflowName?: string;
};

export function WorkflowWorkbench({
  workflow,
  source,
  loaderGraph,
  events,
  orgId,
  readOnly: forceReadOnly,
  flushHeader,
  canRun = true,
  footer,
  trackInstanceId,
  runWorkflowName = "automation-codemode-script",
}: {
  workflow: string;
  source: WorkflowSource;
  loaderGraph: WorkflowGraph;
  events: RunnableEvent[];
  orgId: string | null;
  /** Force the editor read-only (view mode) even when the file is writable. */
  readOnly?: boolean;
  /** Render the toolbar as a flush header band (see {@link WorkflowView}). */
  flushHeader?: boolean;
  /**
   * Whether the workflow can be run from here. Off for surfaces with no file to
   * execute (e.g. a codemode run), which drops the run controls entirely.
   */
  canRun?: boolean;
  /**
   * An already-scheduled run to track live (e.g. a codemode run the agent kicked
   * off). When set, the graph highlights its progress without a manual Run — the
   * emissions stream in and step nodes light up as it executes.
   */
  trackInstanceId?: string;
  /** The workflow name backing `trackInstanceId` (and any manual run). */
  runWorkflowName?: string;
  /**
   * Extra content rendered in the footer slot when no run is in progress — e.g.
   * a codemode run's captured output. The live emissions log takes precedence
   * while a run is active.
   */
  footer?: ReactNode;
}) {
  const previewFetcher = useFetcher<WorkflowActionData>();
  const saveFetcher = useFetcher<WorkflowActionData>();
  const runFetcher = useFetcher<WorkflowActionData>();
  const [code, setCode] = useState(source.body);

  const readOnly = forceReadOnly || source.readOnly;

  // The server body we last synced from. When "Go live" (or a save) brings in a
  // newer body, adopt it into the editor *only* if the user hasn't diverged —
  // so external edits flow in live, but unsaved local edits are never clobbered.
  const lastServerBody = useRef(source.body);
  useEffect(() => {
    if (source.body === lastServerBody.current) {
      return;
    }
    setCode((current) => (current === lastServerBody.current ? source.body : current));
    lastServerBody.current = source.body;
  }, [source.body]);

  const dirty = code !== source.body;

  // Debounced re-parse of the edited body. Skipped while clean so the loader
  // graph (which may be refreshing via "Go live") stays authoritative.
  useEffect(() => {
    if (!dirty) {
      return undefined;
    }
    const id = setTimeout(() => {
      void previewFetcher.submit(
        { intent: "preview", workflow, path: source.absolutePath, body: code },
        { method: "post", action: WORKFLOWS_ACTION },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
    };
    // previewFetcher identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, dirty, workflow, source.absolutePath]);

  const previewData = previewFetcher.data;
  const previewGraph =
    previewData && "graph" in previewData && previewData.graph ? previewData.graph : null;

  // While dirty, prefer the freshest preview; fall back to the loader graph until
  // the first preview lands so the canvas never blanks mid-edit.
  const activeGraph = dirty && previewGraph ? previewGraph : loaderGraph;

  const errors = activeGraph.diagnostics.filter((d) => d.severity === "error");
  const warnings = activeGraph.diagnostics.filter((d) => d.severity === "warning");

  const saveError =
    saveFetcher.data && !saveFetcher.data.ok ? (saveFetcher.data.error ?? "Save failed.") : null;

  const onSave = () => {
    if (readOnly || !dirty) {
      return;
    }
    void saveFetcher.submit(
      { intent: "save", workflow, path: source.absolutePath, body: code },
      { method: "post", action: WORKFLOWS_ACTION },
    );
  };

  // Manual execution: kick off via the action, then stream/poll progress and
  // highlight the matching step nodes on `activeGraph`.
  const workflowRun = useWorkflowRun({
    orgId,
    graph: activeGraph,
    runWorkflowName,
  });
  const { run, reset } = workflowRun;

  // Start tracking once the action returns an instance id (once per submission).
  const startedInstance = useRef<string | null>(null);
  const runData = runFetcher.data;
  useEffect(() => {
    if (runData && "instanceId" in runData && runData.ok && runData.instanceId) {
      if (startedInstance.current !== runData.instanceId) {
        startedInstance.current = runData.instanceId;
        run(runData.instanceId);
      }
    }
  }, [runData, run]);

  // Track a run the caller already scheduled (e.g. a codemode run). The instance
  // exists before this mounts, so we just start watching it; if it already
  // finished, the history/status poll backfills the final state and the emission
  // snapshot replays. Tracked once per instance, like a manual run.
  useEffect(() => {
    if (trackInstanceId && startedInstance.current !== trackInstanceId) {
      startedInstance.current = trackInstanceId;
      run(trackInstanceId);
    }
  }, [trackInstanceId, run]);

  const onRun = (input: { source: string; eventType: string; payload: string }) => {
    void runFetcher.submit(
      {
        intent: "run",
        workflow,
        source: input.source,
        eventType: input.eventType,
        payload: input.payload,
      },
      { method: "post", action: WORKFLOWS_ACTION },
    );
  };

  const runActionError =
    runData && !runData.ok && "error" in runData ? (runData.error ?? "Run failed.") : null;
  const runError = workflowRun.error ?? runActionError;
  const running = runFetcher.state !== "idle" || workflowRun.status === "starting";
  const showRunPanel = workflowRun.status !== "idle" || runFetcher.state !== "idle";
  const parsing = previewFetcher.state !== "idle";
  const saving = saveFetcher.state !== "idle";

  const banner =
    errors.length + warnings.length > 0 || saveError || runError ? (
      <>
        {errors.length + warnings.length > 0 ? (
          <DiagnosticsBanner diagnostics={[...errors, ...warnings]} />
        ) : null}
        {saveError ? <ErrorBanner message={saveError} /> : null}
        {runError ? <ErrorBanner message={runError} /> : null}
      </>
    ) : null;

  return (
    <WorkflowView
      graph={activeGraph}
      runState={workflowRun.stepStatesByNodeId}
      flushHeader={flushHeader}
      banner={banner}
      footer={
        showRunPanel ? (
          <RunFooter
            steps={workflowRun.steps}
            emissions={workflowRun.emissions}
            output={workflowRun.output}
            status={workflowRun.status}
          />
        ) : (
          (footer ?? null)
        )
      }
      // Viewing a workflow opens on the graph; editing opens the code beside it.
      defaultMode={readOnly ? "graph" : "split"}
      code={{
        value: code,
        engine: source.engine,
        onChange: readOnly ? undefined : setCode,
        onSave,
      }}
      toolbar={
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="cad-mono truncate text-[11px] text-[var(--cad-muted-2)]"
              title={source.absolutePath}
            >
              {source.path}
            </span>
            {parsing ? (
              <span className="cad-mono text-[10px] text-[var(--cad-muted-2)]">parsing…</span>
            ) : dirty ? (
              <span className="cad-mono text-[10px] text-[var(--cad-brass-strong)]">unsaved</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canRun ? (
              <RunBar
                status={workflowRun.status}
                running={running}
                disabled={dirty || !orgId}
                disabledReason={dirty ? "Save to run" : !orgId ? "No organization" : undefined}
                events={events}
                onRun={onRun}
                onReset={reset}
              />
            ) : null}
            {readOnly ? (
              <span className="cad-mono text-[10px] text-[var(--cad-muted-2)]">read-only</span>
            ) : (
              <CadenceGhostButton
                type="button"
                onClick={onSave}
                disabled={!dirty || saving}
                className="px-3 py-1.5 text-xs"
              >
                <Save className={`h-3.5 w-3.5 ${saving ? "animate-pulse" : ""}`} />
                {saving ? "Saving…" : "Save"}
              </CadenceGhostButton>
            )}
          </div>
        </div>
      }
    />
  );
}

const RUN_STATUS_BADGE: Record<RunStatusValue, Status | null> = {
  idle: null,
  starting: "running",
  active: "running",
  waiting: "deploying",
  paused: "paused",
  complete: "succeeded",
  errored: "failed",
  terminated: "paused",
};

type RunStatusValue = ReturnType<typeof useWorkflowRun>["status"];

/** Run controls for the top bar: a run trigger (opens a config dropdown), the
 * live status badge, and a reset once the run is terminal. */
function RunBar({
  status,
  running,
  disabled,
  disabledReason,
  events,
  onRun,
  onReset,
}: {
  status: RunStatusValue;
  running: boolean;
  disabled: boolean;
  disabledReason?: string;
  events: RunnableEvent[];
  onRun: (input: { source: string; eventType: string; payload: string }) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Pick a trigger event (its declared payload schema drives the form). The
  // "custom" sentinel lets the operator hand-author an event + raw JSON payload.
  const eventKey = (event: RunnableEvent) => `${event.source}/${event.eventType}`;
  const [selectedKey, setSelectedKey] = useState<string>(
    events.length > 0 ? eventKey(events[0]) : CUSTOM_EVENT_KEY,
  );
  const activeEvent = events.find((event) => eventKey(event) === selectedKey) ?? null;

  const [customSource, setCustomSource] = useState("manual");
  const [customEventType, setCustomEventType] = useState("");
  const [payload, setPayload] = useState("{}");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  // `raw` drops a schema-backed event to a free-form JSON editor.
  const [raw, setRaw] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const terminal = status === "complete" || status === "errored" || status === "terminated";
  const badge = RUN_STATUS_BADGE[status];

  const eventSource = activeEvent ? activeEvent.source : customSource;
  const eventType = activeEvent ? activeEvent.eventType : customEventType;
  const fields = activeEvent?.fields ?? [];
  const useFields = activeEvent !== null && fields.length > 0 && !raw;

  const setField = (name: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
  };

  const onSelectEvent = (key: string) => {
    setSelectedKey(key);
    setRaw(false);
    setFieldValues({});
    setFormError(null);
  };

  const submit = () => {
    const built = useFields
      ? buildPayloadFromFields(fields, fieldValues)
      : parseJsonPayload(payload);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    if (!eventType.trim()) {
      setFormError("An event type is required.");
      return;
    }
    setFormError(null);
    onRun({
      source: eventSource.trim() || "manual",
      eventType: eventType.trim(),
      payload: JSON.stringify(built.payload),
    });
    setOpen(false);
  };

  return (
    <div className="relative flex items-center gap-2">
      <CadenceGhostButton
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        disabled={disabled || running}
        title={disabled ? disabledReason : "Run this workflow"}
        className="px-3 py-1.5 text-xs"
      >
        <Play className={`h-3.5 w-3.5 ${running ? "animate-pulse" : ""}`} />
        {running ? "Running…" : "Run"}
      </CadenceGhostButton>
      {badge ? <StatusBadge status={badge} /> : null}
      {terminal ? (
        <CadenceGhostButton type="button" onClick={onReset} className="px-2.5 py-1.5 text-xs">
          Clear
        </CadenceGhostButton>
      ) : null}

      {open ? (
        <div className="absolute top-full right-0 z-20 mt-2 flex w-80 flex-col gap-2 rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel)] p-3 shadow-[var(--cad-shadow)]">
          <label className="flex flex-col gap-1">
            <span className="cad-eyebrow text-[var(--cad-muted-2)]">trigger event</span>
            <select
              value={selectedKey}
              onChange={(e) => {
                onSelectEvent(e.target.value);
              }}
              className="cad-mono rounded border border-[color:var(--cad-line)] bg-[var(--cad-bg-2)] px-2 py-1 text-xs text-[var(--cad-fg)] outline-none"
            >
              {events.map((event) => (
                <option key={eventKey(event)} value={eventKey(event)}>
                  {event.label} · {event.source}/{event.eventType}
                </option>
              ))}
              <option value={CUSTOM_EVENT_KEY}>Custom event…</option>
            </select>
          </label>

          {activeEvent === null ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex flex-1 flex-col gap-1">
                <span className="cad-eyebrow text-[var(--cad-muted-2)]">source</span>
                <input
                  value={customSource}
                  onChange={(e) => {
                    setCustomSource(e.target.value);
                  }}
                  className="cad-mono rounded border border-[color:var(--cad-line)] bg-[var(--cad-bg-2)] px-2 py-1 text-xs text-[var(--cad-fg)] outline-none"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="cad-eyebrow text-[var(--cad-muted-2)]">eventType</span>
                <input
                  value={customEventType}
                  onChange={(e) => {
                    setCustomEventType(e.target.value);
                  }}
                  placeholder="workflow.test"
                  className="cad-mono rounded border border-[color:var(--cad-line)] bg-[var(--cad-bg-2)] px-2 py-1 text-xs text-[var(--cad-fg)] outline-none"
                />
              </label>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <span className="cad-eyebrow text-[var(--cad-muted-2)]">payload</span>
            {activeEvent !== null && fields.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setRaw((v) => !v);
                }}
                className="cad-mono text-[10px] text-[var(--cad-muted-2)] underline-offset-2 hover:underline"
              >
                {raw ? "Use form" : "Edit as JSON"}
              </button>
            ) : null}
          </div>

          {useFields ? (
            <div className="flex flex-col gap-2">
              {fields.map((field) => (
                <SchemaField
                  key={field.name}
                  field={field}
                  value={fieldValues[field.name] ?? ""}
                  onChange={(value) => {
                    setField(field.name, value);
                  }}
                />
              ))}
            </div>
          ) : (
            <textarea
              value={payload}
              onChange={(e) => {
                setPayload(e.target.value);
              }}
              spellCheck={false}
              rows={4}
              className="cad-mono cad-scroll resize-none rounded border border-[color:var(--cad-line)] bg-[var(--cad-bg-2)] px-2 py-1.5 text-xs leading-relaxed text-[var(--cad-fg)] outline-none"
            />
          )}

          {formError ? <p className="text-[11px] text-[var(--cad-rose)]">{formError}</p> : null}
          <div className="flex justify-end">
            <CadenceButton type="button" onClick={submit}>
              Run workflow
            </CadenceButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const CUSTOM_EVENT_KEY = "__custom__";

/** A single typed input for one parsed schema field. */
function SchemaField({
  field,
  value,
  onChange,
}: {
  field: WorkflowInputField;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputClass =
    "cad-mono rounded border border-[color:var(--cad-line)] bg-[var(--cad-bg-2)] px-2 py-1 text-xs text-[var(--cad-fg)] outline-none";
  const label = (
    <span className="cad-eyebrow flex items-center gap-1.5 text-[var(--cad-muted-2)]">
      {field.name}
      <span className="cad-mono text-[9px] text-[var(--cad-muted-2)]">
        {field.type}
        {field.optional ? "?" : ""}
      </span>
    </span>
  );

  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => {
            onChange(e.target.checked ? "true" : "false");
          }}
        />
        {label}
      </label>
    );
  }

  if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
    return (
      <label className="flex flex-col gap-1">
        {label}
        <select
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={inputClass}
        >
          <option value="">{field.optional ? "— none —" : "— select —"}</option>
          {field.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      {label}
      <input
        type={field.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={field.description}
        className={inputClass}
      />
    </label>
  );
}

type PayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

function parseJsonPayload(raw: string): PayloadResult {
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Payload must be a JSON object." };
  }
  return { ok: true, payload: parsed as Record<string, unknown> };
}

/** Coerce typed form values into a payload object, validating required fields. */
function buildPayloadFromFields(
  fields: WorkflowInputField[],
  values: Record<string, string>,
): PayloadResult {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? "").trim();
    if (raw === "" && field.type !== "boolean") {
      if (field.optional) {
        continue;
      }
      return { ok: false, error: `"${field.name}" is required.` };
    }
    switch (field.type) {
      case "number": {
        const num = Number(raw);
        if (Number.isNaN(num)) {
          return { ok: false, error: `"${field.name}" must be a number.` };
        }
        payload[field.name] = num;
        break;
      }
      case "boolean":
        payload[field.name] = (values[field.name] ?? "") === "true";
        break;
      case "unknown": {
        // Best-effort: accept JSON, else treat as a plain string.
        try {
          payload[field.name] = JSON.parse(raw);
        } catch {
          payload[field.name] = raw;
        }
        break;
      }
      case "enum":
      case "string":
        payload[field.name] = raw;
        break;
    }
  }
  return { ok: true, payload };
}

type RunTab = "steps" | "output" | "emissions";

/**
 * The live run panel shown beneath the graph while a run is tracked: the step
 * executions (status, attempts, errors), the run's final output once it lands,
 * and the raw emission feed — mirroring the backoffice automations instance
 * detail, scoped to fit the panel. The three are split across tabs (rather than
 * stacked) so the panel stays compact in the companion view.
 */
function RunFooter({
  steps,
  emissions,
  output,
  status,
}: {
  steps: RunStep[];
  emissions: RunEmission[];
  output: unknown;
  status: RunStatusValue;
}) {
  // The run only has a meaningful output once it completes; while it is still
  // running an absent output just means "not produced yet".
  const hasOutput = output !== undefined && output !== null;
  const [tab, setTab] = useState<RunTab>("steps");

  const tabs: { key: RunTab; label: string; count: number | null }[] = [
    { key: "steps", label: "Steps", count: steps.length || null },
    { key: "output", label: "Output", count: null },
    { key: "emissions", label: "Emissions", count: emissions.length || null },
  ];

  return (
    <div className="flex max-h-72 shrink-0 flex-col overflow-hidden rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)]">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-[color:var(--cad-line)] px-2 py-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
            }}
            aria-pressed={tab === t.key}
            className={cn(
              "cad-eyebrow inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors",
              tab === t.key
                ? "bg-[var(--cad-panel-2)] text-[var(--cad-fg)]"
                : "text-[var(--cad-muted-2)] hover:text-[var(--cad-fg)]",
            )}
          >
            {t.label}
            {t.count !== null ? (
              <span className="cad-mono rounded bg-[var(--cad-bg-2)] px-1 text-[9px] text-[var(--cad-muted-2)]">
                {t.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="cad-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {tab === "steps" ? <StepExecutions steps={steps} emissions={emissions} /> : null}
        {tab === "output" ? (
          <RunOutput output={output} status={status} hasOutput={hasOutput} />
        ) : null}
        {tab === "emissions" ? <EmissionsLog emissions={emissions} /> : null}
      </div>
    </div>
  );
}

/** The run's final output (or error result), formatted as JSON like the automations view. */
function RunOutput({
  output,
  status,
  hasOutput,
}: {
  output: unknown;
  status: RunStatusValue;
  hasOutput: boolean;
}) {
  if (!hasOutput) {
    return <p className="cad-mono text-[11px] text-[var(--cad-muted-2)]">No output yet.</p>;
  }
  const text = formatRunOutput(output);
  const errored = status === "errored";
  return (
    <pre
      className={`cad-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap ${
        errored ? "text-[var(--cad-rose)]" : "text-[var(--cad-muted)]"
      }`}
    >
      {text}
    </pre>
  );
}

/** Render a run output value as readable text, parsing JSON-encoded strings. */
function formatRunOutput(output: unknown): string {
  if (output === null) {
    return "null";
  }
  if (typeof output === "string") {
    // The code may return a JSON string — parse it so it shows structured rather
    // than as an escaped one-liner. Plain strings pass through unchanged.
    const trimmed = output.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return output;
      }
    }
    return output;
  }
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

/** Map a runtime step status onto a Cadence status badge (null → neutral chip). */
const STEP_STATUS_BADGE: Record<string, Status> = {
  pending: "deploying",
  queued: "deploying",
  scheduled: "deploying",
  running: "running",
  active: "running",
  waiting: "deploying",
  sleeping: "paused",
  paused: "paused",
  complete: "succeeded",
  completed: "succeeded",
  succeeded: "succeeded",
  errored: "failed",
  failed: "failed",
  terminated: "paused",
  cancelled: "paused",
};

/** A live, step-by-step execution list for the tracked run — name, status, attempts. */
function StepExecutions({ steps, emissions }: { steps: RunStep[]; emissions: RunEmission[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [steps.length]);

  // Per-step emission counts, a compact hint of live activity within a step.
  const emissionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const emission of emissions) {
      counts.set(emission.stepKey, (counts.get(emission.stepKey) ?? 0) + 1);
    }
    return counts;
  }, [emissions]);

  return (
    <>
      {steps.length === 0 ? (
        <p className="cad-mono text-[11px] text-[var(--cad-muted-2)]">Waiting for steps…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {steps.map((step) => {
            const badge = STEP_STATUS_BADGE[step.status.toLowerCase()];
            const count = emissionCounts.get(step.stepKey) ?? 0;
            return (
              <li
                key={step.id || step.stepKey}
                className="flex flex-col gap-1 rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  {badge ? (
                    <StatusBadge status={badge} />
                  ) : (
                    <span className="cad-eyebrow shrink-0 text-[var(--cad-muted-2)]">
                      {step.status}
                    </span>
                  )}
                  <span
                    className="cad-mono min-w-0 flex-1 truncate text-[11px] text-[var(--cad-fg)]"
                    title={`${step.stepKey} · ${step.type}`}
                  >
                    {step.name}
                  </span>
                  <span className="cad-mono shrink-0 text-[10px] text-[var(--cad-muted-2)]">
                    {step.type}
                  </span>
                  <span className="cad-mono shrink-0 text-[10px] text-[var(--cad-muted-2)]">
                    {step.attempts}/{step.maxAttempts}
                    {count > 0 ? ` · ${count} emit${count === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
                {step.error ? (
                  <p className="cad-mono text-[10px] text-[var(--cad-rose)]">
                    {step.error.name}: {step.error.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div ref={endRef} />
    </>
  );
}

function EmissionsLog({ emissions }: { emissions: RunEmission[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [emissions.length]);

  return (
    <>
      {emissions.length === 0 ? (
        <p className="cad-mono text-[11px] text-[var(--cad-muted-2)]">Waiting for emissions…</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {emissions.map((emission) => (
            <li
              key={emission.id}
              className="cad-mono flex gap-2 text-[10px] text-[var(--cad-muted)]"
            >
              <span className="shrink-0 text-[var(--cad-muted-2)]">[{emission.sequence}]</span>
              <span className="shrink-0 text-[var(--cad-fg)]">{emission.stepKey}</span>
              <span className="truncate">{stringifyPayload(emission.payload)}</span>
            </li>
          ))}
        </ul>
      )}
      <div ref={endRef} />
    </>
  );
}

function stringifyPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "";
  }
  try {
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** A full-width error notice (save or run failures), styled like the other banners. */
function ErrorBanner({ message }: { message: string }) {
  return (
    <p className="shrink-0 rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-4 py-2.5 text-xs text-[var(--cad-rose)]">
      {message}
    </p>
  );
}

export function DiagnosticsBanner({ diagnostics }: { diagnostics: WorkflowGraph["diagnostics"] }) {
  return (
    <ul className="space-y-1.5 rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)] px-4 py-3">
      {diagnostics.map((diagnostic, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <span
            className="cad-eyebrow mt-0.5 shrink-0"
            style={{
              color:
                diagnostic.severity === "error" ? "var(--cad-rose)" : "var(--cad-brass-strong)",
            }}
          >
            {diagnostic.severity}
          </span>
          <span className="text-[var(--cad-muted)]">
            {diagnostic.message}
            {diagnostic.ref?.path ? (
              <span className="cad-mono ml-1 text-[var(--cad-muted-2)]">
                ({diagnostic.ref.path}
                {diagnostic.ref.line ? `:${diagnostic.ref.line}` : ""})
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
