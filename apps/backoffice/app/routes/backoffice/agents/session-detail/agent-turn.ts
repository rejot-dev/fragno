import type { PartState } from "@assistant-ui/react";

export type ToolCallPart = Extract<PartState, { type: "tool-call" }>;

/** One row in a turn's activity card. */
export type AgentTurnStep =
  | {
      kind: "thought";
      key: string;
      headline: string;
      /** Whether the model wrote the headline, rather than it being the first sentence. */
      written: boolean;
      text: string;
      running: boolean;
    }
  | { kind: "note"; key: string; text: string }
  | { kind: "image"; key: string; image: string }
  | { kind: "tool"; key: string; part: ToolCallPart };

/** What the agent ended its turn by saying. */
export type AgentTurnAnswerPart =
  | { kind: "text"; key: string; text: string }
  | { kind: "image"; key: string; image: string };

/**
 * A turn's parts, split into the work that led to its answer and the answer itself. The answer
 * is the text after the agent's last thought or tool call; text before that is narration, such
 * as "Let me check the invoices", and reads as a step.
 */
export function agentTurn(
  parts: readonly PartState[],
  running: boolean,
): { steps: AgentTurnStep[]; answer: AgentTurnAnswerPart[] } {
  let answerStart = parts.length;
  while (answerStart > 0) {
    const type = parts[answerStart - 1]?.type;
    if (type !== "text" && type !== "image") {
      break;
    }
    answerStart--;
  }

  const steps: AgentTurnStep[] = [];
  parts.slice(0, answerStart).forEach((part, index) => {
    const key = String(index);
    switch (part.type) {
      case "reasoning": {
        const sections = thoughtSections(part.text);
        sections.forEach((section, sectionIndex) => {
          steps.push({
            kind: "thought",
            key: `${key}:${sectionIndex}`,
            headline: section.headline,
            written: section.written,
            text: section.text,
            running: running && index === answerStart - 1 && sectionIndex === sections.length - 1,
          });
        });
        return;
      }
      case "text":
        if (part.text.trim().length > 0) {
          steps.push({ kind: "note", key, text: part.text });
        }
        return;
      case "image":
        steps.push({ kind: "image", key, image: part.image });
        return;
      case "tool-call":
        steps.push({ kind: "tool", key: part.toolCallId, part });
        return;
      case "audio":
      case "data":
      case "file":
      case "generative-ui":
      case "source":
        return;
    }
  });

  const answer = parts.slice(answerStart).flatMap((part, index): AgentTurnAnswerPart[] => {
    const key = String(answerStart + index);
    if (part.type === "text") {
      return [{ kind: "text", key, text: part.text }];
    }
    if (part.type === "image") {
      return [{ kind: "image", key, image: part.image }];
    }
    return [];
  });
  return { steps, answer };
}

// A line that is only bold text or a heading opens a new section of a thought. OpenAI reasoning
// summaries are written this way; other providers write prose without them.
const SECTION_HEADLINE = /^(?:\*\*(.+?)\*\*|#{1,6}\s+(.+?))\s*:?\s*$/;

/**
 * Splits a thought into sections under their headlines. Prose without a headline, which is how
 * most providers think, takes its first sentence as the headline.
 */
function thoughtSections(text: string): { headline: string; written: boolean; text: string }[] {
  const sections: { headline: string | null; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const match = SECTION_HEADLINE.exec(line.trim());
    const headline = match?.[1] ?? match?.[2];
    if (headline !== undefined) {
      sections.push({ headline: plainText(headline), lines: [] });
    } else if (sections.length === 0) {
      sections.push({ headline: null, lines: [line] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections.flatMap((section) => {
    const body = section.lines.join("\n").trim();
    if (section.headline === null && body.length === 0) {
      return [];
    }
    return [
      {
        headline: section.headline ?? clip(firstSentence(body)),
        written: section.headline !== null,
        text: body,
      },
    ];
  });
}

/**
 * What the agent is doing now, for the header of a running turn: the newest thought's headline,
 * or for prose its newest finished sentence, the tool it runs, or that it is writing its answer.
 */
export function liveHeadline(
  steps: readonly AgentTurnStep[],
  answering: boolean,
  toolHeadline: (part: ToolCallPart) => string,
): string {
  if (answering) {
    return "Writing the answer";
  }
  const step = steps.at(-1);
  if (step === undefined || step.kind === "image") {
    return "Working";
  }
  if (step.kind === "thought") {
    return step.running && !step.written
      ? clip(latestSentence(step.text) ?? step.headline)
      : step.headline;
  }
  return step.kind === "note" ? clip(firstSentence(step.text)) : toolHeadline(step.part);
}

function plainText(markdown: string) {
  return markdown
    .replace(/[*_`~]+/g, "")
    .replace(/^\s*(?:#{1,6}|[-+>]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(markdown: string) {
  const text = plainText(markdown);
  return /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

/** The newest sentence that has ended; null until the first one does. */
function latestSentence(markdown: string) {
  const sentences = plainText(markdown).match(/[^.!?]+[.!?](?=\s|$)/g);
  return sentences?.at(-1)?.trim() ?? null;
}

const HEADLINE_LENGTH = 80;

function clip(text: string) {
  if (text.length <= HEADLINE_LENGTH) {
    return text;
  }
  const cut = text.slice(0, HEADLINE_LENGTH);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), HEADLINE_LENGTH / 2)).trimEnd()}…`;
}
