import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import type { InstanceStatus } from "@fragno-dev/workflows";

import { workflowsClient } from "./workflows-client";

const detailTabs = ["run", "events"] as const;

type DetailTab = (typeof detailTabs)[number];

type InstanceSummary = {
  id: string;
  createdAt: Date | string;
  details: { status: InstanceStatus["status"]; error?: { name: string; message: string } };
};

type WorkflowSummary = {
  name: string;
};

type HistoryStep = {
  id: string;
  name: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  result?: unknown | null;
  error?: { name: string; message: string };
};

type HistoryEvent = {
  id: string;
  type: string;
  createdAt: Date;
};

export function InstancesView() {
  const {
    useWorkflows,
    useWorkflowInstances,
    useSendEvent,
    usePauseInstance,
    useResumeInstance,
    useTerminateInstance,
    useRestartInstance,
    helpers,
  } = workflowsClient;

  const [detailTab, setDetailTab] = useState<DetailTab>("run");
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedWorkflow = searchParams.get("workflow") ?? "approval-workflow";
  const selectedInstance = searchParams.get("instance");
  const [eventType, setEventType] = useState("approval");
  const [eventPayload, setEventPayload] = useState(
    '{\n  "approved": true,\n  "approver": "client-demo"\n}',
  );
  const [eventError, setEventError] = useState<string | null>(null);
  const [includeLogs, setIncludeLogs] = useState(false);

  const { data: workflowsData, loading: workflowsLoading } = useWorkflows();

  const workflows = useMemo(() => {
    const list = workflowsData?.workflows ?? [];
    return list as WorkflowSummary[];
  }, [workflowsData]);

  useEffect(() => {
    if (workflows.length === 0) {
      return;
    }
    if (!selectedWorkflow || !workflows.some((workflow) => workflow.name === selectedWorkflow)) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("workflow", workflows[0].name);
      nextParams.delete("instance");
      setSearchParams(nextParams, { replace: true });
    }
  }, [searchParams, setSearchParams, selectedWorkflow, workflows]);

  const { data: instancesData, loading: instancesLoading } = useWorkflowInstances({
    path: { workflowName: selectedWorkflow },
    query: { pageSize: "50" },
  });

  const instances = useMemo(() => {
    if (!instancesData || !("instances" in instancesData)) {
      return [] as InstanceSummary[];
    }
    return [...instancesData.instances].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
  }, [instancesData]);

  useEffect(() => {
    if (instancesLoading) {
      return;
    }
    if (instances.length === 0) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("instance");
      setSearchParams(nextParams, { replace: true });
      return;
    }
    if (!selectedInstance || !instances.some((instance) => instance.id === selectedInstance)) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("instance", instances[0].id);
      setSearchParams(nextParams, { replace: true });
    }
  }, [instances, instancesLoading, searchParams, selectedInstance, setSearchParams]);

  useEffect(() => {
    setDetailTab("run");
  }, [selectedInstance]);

  const { mutate: sendEvent, loading: eventLoading, error: sendEventError } = useSendEvent();
  const { mutate: pauseInstance, loading: pauseLoading } = usePauseInstance();
  const { mutate: resumeInstance, loading: resumeLoading } = useResumeInstance();
  const { mutate: terminateInstance, loading: terminateLoading } = useTerminateInstance();
  const { mutate: restartInstance, loading: restartLoading } = useRestartInstance();

  const statusCounts = useMemo(() => {
    return instances.reduce<Record<string, number>>((acc, instance) => {
      const status = instance.details.status;
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});
  }, [instances]);

  const completedCount = statusCounts.complete ?? 0;
  const erroredCount = statusCounts.errored ?? 0;

  const handleSendEvent = useCallback(async () => {
    if (!selectedInstance) {
      setEventError("Select an instance first.");
      return;
    }

    let payload: unknown = undefined;
    setEventError(null);

    if (eventPayload.trim()) {
      try {
        payload = JSON.parse(eventPayload);
      } catch {
        setEventError("Payload must be valid JSON.");
        return;
      }
    }

    await sendEvent({
      path: { workflowName: selectedWorkflow, instanceId: selectedInstance },
      body: { type: eventType, payload },
    });
  }, [eventPayload, eventType, selectedInstance, selectedWorkflow, sendEvent]);

  const handleWorkflowChange = useCallback(
    (value: string) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("workflow", value);
      nextParams.delete("instance");
      setSearchParams(nextParams);
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr] lg:items-stretch">
      <aside className="flex h-[calc(100vh-220px)] flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="p-5">
          <label className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-400">
            Workflow type
          </label>
          <select
            value={selectedWorkflow}
            onChange={(event) => handleWorkflowChange(event.target.value)}
            className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
          >
            {workflows.map((workflow) => (
              <option key={workflow.name} value={workflow.name}>
                {workflow.name}
              </option>
            ))}
          </select>
          {workflowsLoading && <p className="mt-2 text-xs text-slate-400">Loading…</p>}
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-t border-slate-100 px-5 pb-5 pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">Instances</h3>
            <span className="text-xs text-slate-400">{instances.length} total</span>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-auto pr-1">
            {instancesLoading && <p className="text-sm text-slate-500">Loading…</p>}
            {!instancesLoading && instances.length === 0 && (
              <p className="text-sm text-slate-500">No instances for this workflow.</p>
            )}
            <div className="grid gap-2">
              {instances.map((instance) => (
                <button
                  key={instance.id}
                  type="button"
                  onClick={() => {
                    const nextParams = new URLSearchParams(searchParams);
                    nextParams.set("instance", instance.id);
                    setSearchParams(nextParams);
                  }}
                  className={`flex flex-col gap-1 rounded-xl border px-3 py-2 text-left text-sm transition ${
                    selectedInstance === instance.id
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    {instance.id}
                  </span>
                  <span className="font-semibold text-slate-700">
                    {helpers.statusLabel(instance.details.status)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>

      <section className="min-h-[520px] rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {!selectedInstance ? (
          <div className="grid h-full gap-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-400">
                Overview
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">Instance summary</h2>
              <p className="mt-2 max-w-2xl text-sm text-slate-600">
                Select an instance to see its live details and history. The summary below highlights
                completed and errored runs for the current workflow type.
              </p>
            </div>
            <div className="grid gap-4 rounded-2xl bg-slate-50 p-6 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Completed
                </p>
                <p className="mt-2 text-3xl font-semibold text-slate-900">{completedCount}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Errored
                </p>
                <p className="mt-2 text-3xl font-semibold text-slate-900">{erroredCount}</p>
              </div>
            </div>
            <div className="rounded-2xl bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                Status snapshot
              </p>
              <div className="mt-3 grid gap-2 text-sm text-slate-600">
                {Object.keys(statusCounts).length === 0 ? (
                  <span className="text-sm text-slate-500">No instances yet.</span>
                ) : (
                  Object.entries(statusCounts).map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between">
                      <span>{helpers.statusLabel(status as InstanceStatus["status"])}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                        {count}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          <InstanceDetailPanel
            workflowName={selectedWorkflow}
            instanceId={selectedInstance}
            detailTab={detailTab}
            setDetailTab={setDetailTab}
            includeLogs={includeLogs}
            setIncludeLogs={setIncludeLogs}
            eventType={eventType}
            setEventType={setEventType}
            eventPayload={eventPayload}
            setEventPayload={setEventPayload}
            eventError={eventError}
            sendEventError={sendEventError}
            eventLoading={!!eventLoading}
            onSendEvent={handleSendEvent}
            pauseLoading={!!pauseLoading}
            resumeLoading={!!resumeLoading}
            restartLoading={!!restartLoading}
            terminateLoading={!!terminateLoading}
            onPause={() =>
              pauseInstance({
                path: { workflowName: selectedWorkflow, instanceId: selectedInstance },
                body: {},
              })
            }
            onResume={() =>
              resumeInstance({
                path: { workflowName: selectedWorkflow, instanceId: selectedInstance },
                body: {},
              })
            }
            onRestart={() =>
              restartInstance({
                path: { workflowName: selectedWorkflow, instanceId: selectedInstance },
                body: {},
              })
            }
            onTerminate={() =>
              terminateInstance({
                path: { workflowName: selectedWorkflow, instanceId: selectedInstance },
                body: {},
              })
            }
          />
        )}
      </section>
    </div>
  );
}

type InstanceDetailPanelProps = {
  workflowName: string;
  instanceId: string;
  detailTab: DetailTab;
  setDetailTab: (tab: DetailTab) => void;
  includeLogs: boolean;
  setIncludeLogs: (value: boolean) => void;
  eventType: string;
  setEventType: (value: string) => void;
  eventPayload: string;
  setEventPayload: (value: string) => void;
  eventError: string | null;
  sendEventError: unknown;
  eventLoading: boolean;
  onSendEvent: () => void;
  pauseLoading: boolean;
  resumeLoading: boolean;
  restartLoading: boolean;
  terminateLoading: boolean;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onTerminate: () => void;
};

function InstanceDetailPanel({
  workflowName,
  instanceId,
  detailTab,
  setDetailTab,
  includeLogs,
  setIncludeLogs,
  eventType,
  setEventType,
  eventPayload,
  setEventPayload,
  eventError,
  sendEventError,
  eventLoading,
  onSendEvent,
  pauseLoading,
  resumeLoading,
  restartLoading,
  terminateLoading,
  onPause,
  onResume,
  onRestart,
  onTerminate,
}: InstanceDetailPanelProps) {
  const { useInstance, useInstanceHistory, helpers } = workflowsClient;
  const { data, loading, error } = useInstance({
    path: { workflowName, instanceId },
  });
  const {
    data: historyData,
    loading: historyLoading,
    error: historyError,
  } = useInstanceHistory({
    path: { workflowName, instanceId },
    query: {
      pageSize: "12",
      includeLogs: includeLogs ? "true" : "false",
      order: "desc",
    },
  });

  const steps = useMemo(() => {
    if (!historyData) {
      return [] as HistoryStep[];
    }
    return historyData.steps as HistoryStep[];
  }, [historyData]);

  const events = useMemo(() => {
    if (!historyData) {
      return [] as HistoryEvent[];
    }
    return historyData.events as HistoryEvent[];
  }, [historyData]);

  const showEventError = Boolean(eventError || sendEventError);

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
            Instance
          </p>
          <h3 className="mt-2 text-xl font-semibold text-slate-900">{instanceId}</h3>
          {loading ? (
            <p className="mt-2 text-sm text-slate-500">Loading status…</p>
          ) : error || !data ? (
            <p className="mt-2 text-sm text-red-600">Unable to load instance details.</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                {helpers.statusLabel(data.details.status)}
              </span>
              <span className="text-xs text-slate-500">Run #{data.meta.runNumber}</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onPause}
            disabled={pauseLoading}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {pauseLoading ? "Pausing…" : "Pause"}
          </button>
          <button
            type="button"
            onClick={onResume}
            disabled={resumeLoading}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {resumeLoading ? "Resuming…" : "Resume"}
          </button>
          <button
            type="button"
            onClick={onRestart}
            disabled={restartLoading}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {restartLoading ? "Restarting…" : "Restart"}
          </button>
          <button
            type="button"
            onClick={onTerminate}
            disabled={terminateLoading}
            className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 transition hover:border-red-300 disabled:cursor-not-allowed disabled:text-red-300"
          >
            {terminateLoading ? "Terminating…" : "Terminate"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {detailTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setDetailTab(tab)}
            className={`rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition ${
              detailTab === tab
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {tab === "run" ? "Run details" : "Send event"}
          </button>
        ))}
      </div>

      {detailTab === "run" ? (
        <div className="grid gap-5">
          <section className="rounded-2xl bg-slate-50 p-4">
            <h4 className="text-sm font-semibold text-slate-700">Details</h4>
            {loading && <p className="mt-3 text-sm text-slate-500">Loading instance…</p>}
            {error && <p className="mt-3 text-sm text-red-600">Unable to load details.</p>}
            {!loading && !error && data && (
              <div className="mt-3 grid gap-3 text-sm text-slate-600">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Status</span>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold">
                    {helpers.statusLabel(data.details.status)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Created</span>
                  <span>{data.meta.createdAt.toLocaleString()}</span>
                </div>
                {data.meta.currentStep && (
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                      Current step
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      {helpers.currentStepLabel(data.meta.currentStep)}
                    </p>
                  </div>
                )}
                <details className="rounded-lg bg-white p-3" open={false}>
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Input (params)
                  </summary>
                  <pre className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    <code>{JSON.stringify(data.meta.params ?? {}, null, 2)}</code>
                  </pre>
                </details>
                <details className="rounded-lg bg-white p-3" open={false}>
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Output
                  </summary>
                  {typeof data.details.output === "undefined" ? (
                    <p className="mt-3 text-xs text-slate-500">No output recorded yet.</p>
                  ) : (
                    <pre className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <code>{JSON.stringify(data.details.output, null, 2)}</code>
                    </pre>
                  )}
                </details>
              </div>
            )}
          </section>

          <section className="rounded-2xl bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-slate-700">History</h4>
              <label className="flex items-center gap-2 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={includeLogs}
                  onChange={(event) => setIncludeLogs(event.target.checked)}
                />
                Include logs
              </label>
            </div>
            {historyLoading && <p className="mt-3 text-sm text-slate-500">Loading history…</p>}
            {historyError && <p className="mt-3 text-sm text-red-600">Unable to load history.</p>}
            {!historyLoading && !historyError && historyData && (
              <div className="mt-4 grid gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Steps
                  </p>
                  <div className="mt-2 grid gap-2">
                    {steps.length === 0 ? (
                      <span className="text-sm text-slate-500">No steps yet.</span>
                    ) : (
                      steps.map((step) => (
                        <div
                          key={step.id}
                          className="grid gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-slate-700">{step.name}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                step.status === "completed"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : step.status === "failed" || step.status === "errored"
                                    ? "bg-red-100 text-red-700"
                                    : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {step.status}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                            <span>Type: {step.type}</span>
                            <span>
                              Attempts: {step.attempts} / {step.maxAttempts}
                            </span>
                            <span>Created: {new Date(step.createdAt).toLocaleString()}</span>
                            <span>Updated: {new Date(step.updatedAt).toLocaleString()}</span>
                          </div>
                          {step.error && (
                            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                              <span className="font-semibold">{step.error.name}</span>:{" "}
                              {step.error.message}
                            </div>
                          )}
                          {typeof step.result !== "undefined" && step.result !== null && (
                            <details
                              className="rounded-lg bg-white px-3 py-2 text-xs text-slate-600"
                              open={false}
                            >
                              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                                Step output
                              </summary>
                              <pre className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                                <code>{JSON.stringify(step.result, null, 2)}</code>
                              </pre>
                            </details>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Events
                  </p>
                  <div className="mt-2 grid gap-2">
                    {events.length === 0 ? (
                      <span className="text-sm text-slate-500">No events yet.</span>
                    ) : (
                      events.map((event) => (
                        <div
                          key={event.id}
                          className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"
                        >
                          <span>{event.type}</span>
                          <span className="text-xs text-slate-500">
                            {new Date(event.createdAt).toLocaleString()}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h4 className="text-sm font-semibold text-slate-700">Send event</h4>
          <p className="mt-2 text-xs text-slate-500">
            Deliver a custom event payload to the workflow instance.
          </p>

          <div className="mt-4 grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Event type
            </label>
            <input
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            />
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Payload (JSON)
            </label>
            <textarea
              value={eventPayload}
              onChange={(event) => setEventPayload(event.target.value)}
              rows={7}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs"
            />
            {showEventError && (
              <p className="text-xs text-red-600">{eventError ?? "Failed to send event."}</p>
            )}
            <button
              type="button"
              onClick={onSendEvent}
              disabled={eventLoading}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {eventLoading ? "Sending…" : "Send event"}
            </button>
            <button
              type="button"
              onClick={() =>
                setEventPayload('{\n  "approved": true,\n  "approver": "client-demo"\n}')
              }
              className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300"
            >
              Reset example payload
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
