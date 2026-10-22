import {
  BackofficeUiErrorBoundary,
  BackofficeUiRenderer,
} from "@fragno-private/backoffice-ui/renderer";
import type { BackofficeUiParseResult } from "@fragno-private/backoffice-ui/result";
import { ScrollablePre } from "@fragno-private/design-system/scrollable-pre";
import { SectionDisclosure } from "@fragno-private/design-system/section-disclosure";
import type { ReactNode } from "react";

import { formatResultValue } from "./tool-arguments";

export function ResultContent({
  children,
  parsedValue,
  showRawValue,
  value,
}: {
  children?: ReactNode;
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

export function RawValueDisclosure({ value }: { value: unknown }) {
  return (
    <SectionDisclosure label="Raw result">
      <RawValue value={value} />
    </SectionDisclosure>
  );
}

// Formatting waits for the disclosure to open, because raw results can be large.
function RawValue({ value }: { value: unknown }) {
  return <ScrollablePre expanded>{formatResultValue(value)}</ScrollablePre>;
}
