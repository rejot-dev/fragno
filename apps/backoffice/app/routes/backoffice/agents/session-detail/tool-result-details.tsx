import { ScrollablePre } from "@fragno-private/design-system/scrollable-pre";

import { formatJson, formatToolArgumentsDisplayText, getCodeArgument } from "./tool-arguments";

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
