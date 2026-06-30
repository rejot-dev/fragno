/*
 * The companion workflow panel — the right side of the exec split. Given a
 * workflow name, it loads that workflow's graph + source from the workflows
 * route loader (the same source-of-truth the Pi agent edits) and renders the
 * shared `WorkflowWorkbench`. In "view" mode the editor is read-only; in "edit"
 * mode it is the full workbench (save, run, live re-derive).
 *
 * It reads through the workflows loader via a fetcher rather than its own server
 * code so there is exactly one place that derives a workflow graph.
 */

import { RefreshCw, Workflow } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useFetcher } from "react-router";

import { WorkflowWorkbench } from "@/components/cadence/workflow-graph/workflow-workbench";
import type { loader as workflowsLoader } from "@/routes/cadence/workflows";

import { CompanionPanel } from "./companion-panel";

export function WorkflowPanel({
  name,
  mode,
  refreshToken,
  onClose,
}: {
  name: string;
  mode: "view" | "edit";
  /** Re-reads the workflow from disk when this changes (after an agent edit). */
  refreshToken?: number;
  onClose: () => void;
}) {
  const fetcher = useFetcher<typeof workflowsLoader>();

  // Load the workflow this panel shows — and reload it when the name changes or
  // `refreshToken` bumps (i.e. the agent wrote the file). The keyed workbench
  // below adopts the fresh source only if the user hasn't diverged locally.
  useEffect(() => {
    void fetcher.load(`/workflows?workflow=${encodeURIComponent(name)}`);
    // fetcher identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, refreshToken]);

  const data = fetcher.data;
  const loading = !data && fetcher.state !== "idle";

  // The workbench renders full-bleed (flush header + edge-to-edge panels) to
  // match the workflows page; the loading / not-found notices keep the panel's
  // padding, so the body is only flush while the workbench itself is shown.
  const hasWorkbench = !!(data && data.source && data.selected && data.graph);

  let body: ReactNode;
  if (data && data.source && data.selected && data.graph) {
    body = (
      <WorkflowWorkbench
        key={data.source.absolutePath}
        workflow={data.selected}
        source={data.source}
        loaderGraph={data.graph}
        events={data.events}
        orgId={data.orgId}
        readOnly={mode === "view"}
        flushHeader
      />
    );
  } else if (loading) {
    body = <PanelNotice icon={<RefreshCw className="h-4 w-4 animate-spin" />} message="Loading…" />;
  } else {
    body = <PanelNotice message={`Workflow “${name}” was not found in this workspace.`} />;
  }

  return (
    <CompanionPanel
      icon={<Workflow className="h-4 w-4 shrink-0 text-[var(--cad-brass)]" />}
      title={data?.selected ?? name}
      badge={mode}
      onClose={onClose}
      flush={hasWorkbench}
    >
      {body}
    </CompanionPanel>
  );
}

function PanelNotice({ icon, message }: { icon?: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-[color:var(--cad-line)] bg-[var(--cad-panel)] p-12">
      <p className="flex items-center gap-2 text-sm text-[var(--cad-muted)]">
        {icon}
        {message}
      </p>
    </div>
  );
}
