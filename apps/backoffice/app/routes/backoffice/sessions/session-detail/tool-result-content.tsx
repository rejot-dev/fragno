import type { BackofficeUiParseResult } from "@/backoffice-ui/result";

import { normalizePiContent, type ToolResultMessage } from "./assistant-runtime";
import { MessageImage, ScrollablePre } from "./message-content";
import { RawValueDisclosure, ResultContent } from "./result-content";
import { formatResultValue } from "./tool-arguments";

export function ToolResultContent({
  expanded,
  hasRawResult,
  parsedResult,
  rawResult,
  result,
  useExecCodeModeFormatting,
}: {
  expanded: boolean;
  hasRawResult: boolean;
  parsedResult: BackofficeUiParseResult;
  rawResult: unknown;
  result: ToolResultMessage;
  useExecCodeModeFormatting: boolean;
}) {
  const messageContent = (
    <div className="space-y-2">
      {normalizePiContent(result.content).map((block) => {
        if (block.type === "text") {
          return <ScrollablePre key={block.text}>{block.text}</ScrollablePre>;
        }
        if (block.type === "image") {
          return (
            <MessageImage
              key={`${block.mimeType}:${block.data}`}
              image={`data:${block.mimeType};base64,${block.data}`}
            />
          );
        }
        return null;
      })}
    </div>
  );

  if (!useExecCodeModeFormatting || !hasRawResult) {
    return messageContent;
  }

  if (parsedResult.kind === "valid") {
    return <RawValueDisclosure value={rawResult} />;
  }

  return (
    <ResultContent parsedValue={parsedResult} showRawValue={expanded} value={rawResult}>
      <ScrollablePre>{formatResultValue(rawResult)}</ScrollablePre>
    </ResultContent>
  );
}
