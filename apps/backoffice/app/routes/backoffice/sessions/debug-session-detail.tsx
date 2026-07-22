import { useMemo } from "react";
import { useOutletContext, useParams } from "react-router";

import { createPiClient } from "@/fragno/pi/pi-client";

import type { PiSessionsOutletContext } from "./sessions";

const stringifyJson = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, current: unknown): unknown => {
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
      }
      if (typeof current === "bigint") {
        return current.toString();
      }
      return current;
    },
    2,
  );

const JsonPanel = ({ title, value }: { title: string; value: unknown }) => (
  <section className="min-h-0 border border-(--bo-border) bg-(--bo-panel)">
    <div className="border-b border-(--bo-border) px-4 py-3">
      <h2 className="text-xs tracking-[0.22em] text-(--bo-muted) uppercase">{title}</h2>
    </div>
    <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-(--bo-foreground)">
      {stringifyJson(value)}
    </pre>
  </section>
);

export default function BackofficeOrganisationPiDebugSessionDetail() {
  const { workflowName, sessionId } = useParams();
  const { scope } = useOutletContext<PiSessionsOutletContext>();
  const resolvedWorkflowName = workflowName ?? "";
  const resolvedSessionId = sessionId ?? "";
  const pi = useMemo(() => createPiClient(scope), [scope]);
  const sessionPath = { workflowName: resolvedWorkflowName, sessionId: resolvedSessionId };
  const sessionDetail = pi.useSessionDetail({ path: sessionPath });

  if (!workflowName || !sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <p className="text-xs tracking-[0.22em] text-(--bo-muted) uppercase">
          Debug session detail
        </p>
        <h1 className="mt-1 font-mono text-lg text-(--bo-foreground)">{resolvedSessionId}</h1>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-2">
        <JsonPanel title="useSessionDetail" value={sessionDetail} />
      </div>
    </div>
  );
}
