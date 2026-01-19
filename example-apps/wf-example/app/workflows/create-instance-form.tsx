import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { workflowsClient } from "./workflows-client";

type WorkflowSummary = {
  name: string;
};

export function CreateInstanceForm() {
  const navigate = useNavigate();
  const { useWorkflows, useCreateInstance } = workflowsClient;

  const [selectedWorkflow, setSelectedWorkflow] = useState("approval-workflow");
  const [createName, setCreateName] = useState("");
  const [createAmount, setCreateAmount] = useState("125");
  const [createRequester, setCreateRequester] = useState("client-demo");
  const [createdId, setCreatedId] = useState<string | null>(null);

  const { data: workflowsData, loading: workflowsLoading } = useWorkflows();
  const {
    mutate: createInstance,
    loading: createLoading,
    error: createError,
  } = useCreateInstance();

  const workflows = useMemo(() => {
    const list = workflowsData?.workflows ?? [];
    return list as WorkflowSummary[];
  }, [workflowsData]);

  useEffect(() => {
    if (workflows.length === 0) {
      return;
    }
    if (!selectedWorkflow || !workflows.some((workflow) => workflow.name === selectedWorkflow)) {
      setSelectedWorkflow(workflows[0].name);
    }
  }, [workflows, selectedWorkflow]);

  const handleCreateInstance = async () => {
    const requestId = createName.trim() || `demo-${crypto.randomUUID()}`;
    await createInstance({
      path: { workflowName: selectedWorkflow },
      body: {
        id: requestId,
        params: {
          requestId,
          amount: Number(createAmount) || 0,
          requestedBy: createRequester || "client-demo",
        },
      },
    });
    setCreatedId(requestId);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-white via-slate-50 to-slate-200/70 p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Payload</p>
        <h2 className="mt-3 text-2xl font-semibold text-slate-900">Shape your new run</h2>
        <p className="mt-4 text-sm text-slate-600">
          Provide identifiers and parameters to kick off a new instance. This form writes directly
          to the fragment API and returns immediately, so you can track the run from the Instances
          page.
        </p>
        <div className="mt-6 rounded-2xl bg-slate-900 p-4 text-xs text-slate-100">
          <p className="font-semibold uppercase tracking-[0.2em] text-slate-400">Example params</p>
          <pre className="mt-3 overflow-x-auto">
            <code>{`{
  "requestId": "req-123",
  "amount": 125,
  "requestedBy": "client-demo"
}`}</code>
          </pre>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="grid gap-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-400">
              Workflow type
            </label>
            <select
              value={selectedWorkflow}
              onChange={(event) => setSelectedWorkflow(event.target.value)}
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm"
            >
              {workflows.map((workflow) => (
                <option key={workflow.name} value={workflow.name}>
                  {workflow.name}
                </option>
              ))}
            </select>
            {workflowsLoading && <p className="mt-2 text-xs text-slate-400">Loading…</p>}
          </div>

          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-400">
              Instance id
            </label>
            <input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="Request id (optional)"
              className="rounded-lg border border-slate-200 px-3 py-2"
            />
          </div>

          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-400">
              Amount
            </label>
            <input
              value={createAmount}
              onChange={(event) => setCreateAmount(event.target.value)}
              placeholder="Amount"
              className="rounded-lg border border-slate-200 px-3 py-2"
            />
          </div>

          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-400">
              Requested by
            </label>
            <input
              value={createRequester}
              onChange={(event) => setCreateRequester(event.target.value)}
              placeholder="Requested by"
              className="rounded-lg border border-slate-200 px-3 py-2"
            />
          </div>

          <button
            type="button"
            onClick={handleCreateInstance}
            disabled={createLoading}
            className="mt-2 rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {createLoading ? "Creating…" : "Create instance"}
          </button>

          {createError && <p className="text-xs text-red-600">Failed to create instance.</p>}

          {createdId && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
              <p className="font-semibold">Instance created</p>
              <p className="mt-1 text-xs text-emerald-700">{createdId}</p>
              <button
                type="button"
                onClick={() => navigate("/instances")}
                className="mt-3 rounded-full bg-emerald-700 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-600"
              >
                View in Instances
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
