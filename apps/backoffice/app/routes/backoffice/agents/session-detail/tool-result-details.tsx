import type { ReactNode } from "react";

import { ScrollablePre } from "./message-content";
import { formatJson, formatToolArgumentsDisplayText, getCodeArgument } from "./tool-arguments";

export function ToolResultDisclosure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <details className="group/disclosure border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 marker:hidden">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </span>
        <span className="text-[10px] font-medium tracking-[0.1em] text-[var(--bo-muted-2)] uppercase">
          <span className="group-open/disclosure:hidden">View</span>
          <span className="hidden group-open/disclosure:inline">Hide</span>
        </span>
      </summary>
      <div className="border-t border-[color:var(--bo-border)] p-2">{children}</div>
    </details>
  );
}

export function ToolArgumentsBlock({ rawText, value }: { rawText?: string; value: unknown }) {
  const codeArgument = getCodeArgument(value);
  if (!codeArgument) {
    return <ScrollablePre>{formatToolArgumentsDisplayText({ rawText, value })}</ScrollablePre>;
  }

  const restKeys = Object.keys(codeArgument.rest);
  return (
    <div className="space-y-2">
      {restKeys.length > 0 ? <ScrollablePre>{formatJson(codeArgument.rest)}</ScrollablePre> : null}
      <ScrollablePre>{formatToolArgumentsDisplayText({ rawText, value })}</ScrollablePre>
    </div>
  );
}
