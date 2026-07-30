import type { ReactNode } from "react";

import { BackofficeUiRenderer } from "@/backoffice-ui/renderer";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import { ScrollablePre } from "./message-content";
import { formatResultValue } from "./tool-arguments";

export function ResultContent({
  children,
  generatedUiEnabled,
  showRawValue,
  value,
}: {
  children: ReactNode;
  generatedUiEnabled: boolean;
  showRawValue: boolean;
  value: unknown;
}) {
  const generatedUiResult = generatedUiEnabled ? parseBackofficeUiResult(value) : null;

  if (generatedUiResult) {
    return (
      <div className="space-y-3">
        <BackofficeUiRenderer ui={generatedUiResult.$ui} />
        {showRawValue ? <ScrollablePre expanded>{formatResultValue(value)}</ScrollablePre> : null}
      </div>
    );
  }

  if (showRawValue) {
    return <ScrollablePre expanded>{formatResultValue(value)}</ScrollablePre>;
  }

  return children;
}
