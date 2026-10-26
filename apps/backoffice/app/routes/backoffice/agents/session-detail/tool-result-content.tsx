import type { BackofficeUiParseResult } from "@fragno-private/backoffice-ui/result";
import { ScrollablePre } from "@fragno-private/design-system/scrollable-pre";

import {
  normalizePiContent,
  type PiContentBlock,
  type ToolResultMessage,
} from "./assistant-runtime";
import { MessageImage } from "./message-content";
import { RawValueDisclosure, ResultContent } from "./result-content";
import { formatResultValue } from "./tool-arguments";

function ImageBlock({ block }: { block: Extract<PiContentBlock, { type: "image" }> }) {
  return <MessageImage image={`data:${block.mimeType};base64,${block.data}`} />;
}

export function ToolResultContent({
  expanded,
  hasRawResult,
  parsedResult,
  rawResult,
  result,
  useCodemodeFormatting,
}: {
  expanded: boolean;
  hasRawResult: boolean;
  parsedResult: BackofficeUiParseResult;
  rawResult: unknown;
  result: ToolResultMessage;
  useCodemodeFormatting: boolean;
}) {
  const blocks = normalizePiContent(result.content);

  if (!useCodemodeFormatting || !hasRawResult) {
    return (
      <div className="space-y-2">
        {blocks.map((block) => {
          if (block.type === "text") {
            return <ScrollablePre key={block.text}>{block.text}</ScrollablePre>;
          }
          if (block.type === "image") {
            return <ImageBlock key={`${block.mimeType}:${block.data}`} block={block} />;
          }
          return null;
        })}
      </div>
    );
  }

  // The images a program viewed, which its result does not carry.
  const images = blocks.flatMap((block) =>
    block.type === "image"
      ? [<ImageBlock key={`${block.mimeType}:${block.data}`} block={block} />]
      : [],
  );

  if (parsedResult.kind === "valid") {
    return (
      <div className="space-y-2">
        <RawValueDisclosure value={rawResult} />
        {images}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ResultContent parsedValue={parsedResult} showRawValue={expanded} value={rawResult}>
        <ScrollablePre>{formatResultValue(rawResult)}</ScrollablePre>
      </ResultContent>
      {images}
    </div>
  );
}
