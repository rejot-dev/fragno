import { ChevronRight } from "lucide-react";

import { serializeWorkflowOutput } from "./workflow-output";

export function WorkflowOutputDisclosure({ value }: { value: unknown }) {
  return (
    <details
      data-workflow-output
      className="group mt-3 border-t border-[color:var(--bo-border)] pt-3"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-muted-2)] uppercase select-none">
        <ChevronRight className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-90" />
        Output
      </summary>
      <div className="mt-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
        <WorkflowOutputData value={value} />
      </div>
    </details>
  );
}

export function WorkflowOutputData({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-[var(--bo-fg)]">
      {serializeWorkflowOutput(value)}
    </pre>
  );
}
