import { formatCodemodeLogLine } from "@fragno-dev/codemode/runtime-api";
import { Button } from "@fragno-private/design-system/button";
import { CodeBlock } from "@fragno-private/design-system/code-block";
import { DataTable } from "@fragno-private/design-system/data-table";
import { useLoaderData, useRevalidator } from "react-router";

import { requireRouteScope } from "@/layouts/backoffice-shell-request.server";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/codemode-run-detail";
import { formatTimestamp, getStepStatusBadgeClasses } from "./workflows-shared";

const TOOL_CALL_COLUMNS = [
  { key: "calledAt", label: "Called at", align: "start" },
  { key: "status", label: "Status", align: "start" },
  { key: "tool", label: "Tool", align: "start" },
  { key: "scope", label: "Scope", align: "start" },
  { key: "durationMs", label: "Duration (ms)", align: "end" },
  { key: "input", label: "Input", align: "start" },
  { key: "output", label: "Output", align: "start" },
] as const;

export async function loader({ context, params }: Route.LoaderArgs) {
  const { execution } = requireRouteScope(context);
  const run = await getBackofficeObjects(context)
    .codemode.for(execution.scope)
    .commands.getRun(params.runId);
  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }
  return {
    run: {
      id: run.id,
      status: run.status,
      activationKind: run.activationKind,
      origin: run.origin.kind === "file" ? run.origin.path : "inline",
      createdAt: run.createdAt,
      error: run.status === "failed" ? run.error.message : null,
      // Logs are stored with the run's outcome, so a running run has none yet.
      logs:
        run.status === "running"
          ? null
          : run.logs.map((line) => formatCodemodeLogLine(line)).join("\n"),
    },
    toolCallsTruncated: run.toolCallsTruncated,
    toolCalls: run.toolCalls.map((call) => ({
      calledAt: formatTimestamp(call.calledAt),
      status: call.status,
      tool: `${call.provider}.${call.tool}`,
      scope: call.scope.kind === "current" ? "current" : Object.values(call.scope).join(":"),
      durationMs:
        call.status === "running"
          ? ""
          : String(Date.parse(call.settledAt) - Date.parse(call.calledAt)),
      input: call.input,
      output: call.status === "running" ? "" : call.output,
    })),
  };
}

export default function BackofficeCodemodeRunDetail() {
  const { run, toolCalls, toolCallsTruncated } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            {run.activationKind} · {formatTimestamp(run.createdAt)}
          </p>
          <h2
            className="mt-2 truncate text-xl font-semibold text-[var(--bo-fg)]"
            title={run.origin}
          >
            {run.origin}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-[var(--bo-muted-2)]">{run.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`border px-2 py-1 text-[9px] tracking-[0.16em] uppercase ${getStepStatusBadgeClasses(run.status)}`}
          >
            {run.status}
          </span>
          {/* Calls are stored as they happen, so a running run shows more on each refresh. */}
          <Button
            variant="secondary"
            onClick={() => void revalidator.revalidate()}
            disabled={revalidator.state === "loading"}
          >
            Refresh
          </Button>
        </div>
      </div>

      {run.error ? (
        <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-700">{run.error}</div>
      ) : null}

      {run.logs === null ? (
        <p className="text-sm text-[var(--bo-muted)]">Logs appear once the run finishes.</p>
      ) : run.logs === "" ? (
        <p className="text-sm text-[var(--bo-muted)]">This run logged nothing.</p>
      ) : (
        <CodeBlock label="Logs" code={run.logs} />
      )}

      {toolCalls.length === 0 ? (
        <p className="text-sm text-[var(--bo-muted)]">This run made no tool calls.</p>
      ) : (
        <DataTable
          caption="Tool calls, oldest first"
          columns={TOOL_CALL_COLUMNS}
          rows={toolCalls}
        />
      )}

      {toolCallsTruncated ? (
        <p className="text-sm text-[var(--bo-muted)]">Only the first 200 tool calls are shown.</p>
      ) : null}
    </div>
  );
}
