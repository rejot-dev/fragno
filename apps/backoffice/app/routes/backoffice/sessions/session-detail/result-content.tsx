import { useState, type ReactNode } from "react";

import { BackofficeUiErrorBoundary, BackofficeUiRenderer } from "@/backoffice-ui/renderer";
import type { BackofficeUiParseResult } from "@/backoffice-ui/result";

import { ScrollablePre } from "./message-content";
import { formatResultValue } from "./tool-arguments";

export function ResultContent({
  children,
  parsedValue,
  showRawValue,
  value,
}: {
  children: ReactNode;
  parsedValue: BackofficeUiParseResult;
  showRawValue: boolean;
  value: unknown;
}) {
  if (parsedValue.kind === "valid") {
    return (
      <BackofficeUiErrorBoundary
        fallback={
          <GeneratedUiFailureNotice
            message="A generated component failed while rendering."
            value={value}
          />
        }
      >
        <div className="space-y-3">
          <BackofficeUiRenderer ui={parsedValue.value.$ui} />
          <RawValueDisclosure value={value} />
        </div>
      </BackofficeUiErrorBoundary>
    );
  }

  if (parsedValue.kind === "invalid") {
    return <GeneratedUiFailureNotice message={parsedValue.message} value={value} />;
  }

  if (showRawValue) {
    return <ScrollablePre expanded>{formatResultValue(value)}</ScrollablePre>;
  }

  return children;
}

function GeneratedUiFailureNotice({ message, value }: { message: string; value: unknown }) {
  return (
    <div role="alert" className="border border-[color:var(--bo-failed)] bg-[var(--bo-panel)] p-3">
      <p className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-failed)] uppercase">
        Generated interface unavailable
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--bo-muted)]">{message}</p>
      <div className="mt-3">
        <RawValueDisclosure value={value} />
      </div>
    </div>
  );
}

function RawValueDisclosure({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className="group/raw border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 marker:hidden">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
          Raw result
        </span>
        <span className="text-[10px] font-medium tracking-[0.1em] text-[var(--bo-muted-2)] uppercase">
          <span className="group-open/raw:hidden">Show</span>
          <span className="hidden group-open/raw:inline">Hide</span>
        </span>
      </summary>
      {open ? (
        <div className="border-t border-[color:var(--bo-border)] p-2">
          <ScrollablePre expanded>{formatResultValue(value)}</ScrollablePre>
        </div>
      ) : null}
    </details>
  );
}
