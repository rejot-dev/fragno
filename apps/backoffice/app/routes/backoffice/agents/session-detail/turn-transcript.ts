import { formatActivityDuration } from "@fragno-private/design-system/chat-activity";

import type { AgentTurnSegment, ToolCallPart } from "./agent-turn";
import { normalizePiContent } from "./assistant-runtime";
import { formatJson, formatResultValue, getCodeArgument } from "./tool-arguments";
import { toolCallPresentation } from "./tool-call";

/**
 * A settled turn as Markdown, for pasting into an issue or another chat: every thought, tool
 * call, and result, whether or not the view shows them, and what it said along the way. What it
 * said last is the answer.
 */
export function turnTranscript({
  segments,
  stopped,
  failure,
}: {
  segments: readonly AgentTurnSegment[];
  stopped: boolean;
  failure: string | null;
}) {
  const sections = segments.flatMap((segment, index) => {
    if (segment.kind === "said") {
      return [
        section(
          index === segments.length - 1 ? "Answer" : "Note",
          segment.parts
            .map((part) => (part.kind === "text" ? part.text : image(part.image)))
            .join("\n\n"),
        ),
      ];
    }
    return segment.steps.map((step) =>
      step.kind === "thought"
        ? section("Thinking", step.written ? `**${step.headline}**\n\n${step.text}` : step.text)
        : toolSection(step.part),
    );
  });
  if (stopped) {
    sections.push(section("Stopped", "The response was stopped before it finished."));
  }
  if (failure !== null) {
    sections.push(section("Error", failure));
  }
  return `${sections.join("\n\n")}\n`;
}

function toolSection(part: ToolCallPart) {
  const result = toolCallPresentation(part).completedToolResult;
  const facts = [
    result?.isError ? "failed" : null,
    result?.durationMs === undefined ? null : formatActivityDuration(result.durationMs),
  ].filter((fact) => fact !== null);
  const title = `Tool call: ${part.toolName}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`;

  const codeArgument = getCodeArgument(part.args);
  const args =
    codeArgument === null
      ? fenced(formatJson(part.args), "json")
      : [
          Object.keys(codeArgument.rest).length > 0
            ? fenced(formatJson(codeArgument.rest), "json")
            : null,
          fenced(codeArgument.code, "js"),
        ]
          .filter((block) => block !== null)
          .join("\n\n");

  // The result as the agent read it, which for code mode includes its logs.
  const output =
    result === null
      ? "_No result._"
      : normalizePiContent(result.content)
          .flatMap((block) =>
            block.type === "text"
              ? [fenced(formatResultValue(block.text), "")]
              : block.type === "image"
                ? [OMITTED_IMAGE]
                : [],
          )
          .join("\n\n") || "_Empty result._";

  return section(
    title,
    `**Arguments**\n\n${args}\n\n**${result?.isError ? "Error" : "Result"}**\n\n${output}`,
  );
}

function section(title: string, body: string) {
  return `### ${title}\n\n${body.trim()}`;
}

// Inline images are base64; pasting megabytes of it helps no one.
const OMITTED_IMAGE = "_Image omitted._";

function image(source: string) {
  return source.startsWith("data:") ? OMITTED_IMAGE : `![Image](${source})`;
}

/** A code fence longer than any backtick run inside the text, so the text cannot close it. */
function fenced(text: string, language: string) {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}
