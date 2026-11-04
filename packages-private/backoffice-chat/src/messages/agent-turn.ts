import type { PartState } from "@assistant-ui/react";

export type ToolCallPart = Extract<PartState, { type: "tool-call" }>;

/** One row in an activity card. */
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
  | { kind: "tool"; key: string; part: ToolCallPart };

/** Something the agent said to the reader. */
export type AgentTurnSaidPart =
  | { kind: "text"; key: string; text: string }
  | { kind: "image"; key: string; image: string };

/**
 * A stretch of a turn: work, the thoughts and tool calls in one activity card, or what the agent
 * said between them. Each is keyed by its first part, so it keeps its identity as it grows.
 */
export type AgentTurnSegment =
  | { kind: "work"; key: string; steps: AgentTurnStep[] }
  | { kind: "said"; key: string; parts: AgentTurnSaidPart[] };

/**
 * A turn's parts, in the order they happened, as alternating work and speech. What the agent says
 * between tool calls, such as "Let me check the invoices", stays where it was said, so text that
 * streamed in does not move once the agent's next step arrives.
 */
export function agentTurn(parts: readonly PartState[], running: boolean): AgentTurnSegment[] {
  const segments: AgentTurnSegment[] = [];
  function work(key: string) {
    const last = segments.at(-1);
    if (last?.kind === "work") {
      return last.steps;
    }
    const steps: AgentTurnStep[] = [];
    segments.push({ kind: "work", key: `work:${key}`, steps });
    return steps;
  }
  function said(part: AgentTurnSaidPart) {
    const last = segments.at(-1);
    if (last?.kind === "said") {
      last.parts.push(part);
    } else {
      segments.push({ kind: "said", key: `said:${part.key}`, parts: [part] });
    }
  }

  parts.forEach((part, index) => {
    const key = String(index);
    switch (part.type) {
      case "reasoning": {
        const sections = thoughtSections(part.text);
        if (sections.length === 0) {
          return;
        }
        const steps = work(key);
        sections.forEach((section, sectionIndex) => {
          steps.push({
            kind: "thought",
            key: `${key}:${sectionIndex}`,
            headline: section.headline,
            written: section.written,
            text: section.text,
            running: running && index === parts.length - 1 && sectionIndex === sections.length - 1,
          });
        });
        return;
      }
      case "text":
        // Blank text between steps would split their card in two.
        if (part.text.trim().length > 0) {
          said({ kind: "text", key, text: part.text });
        }
        return;
      case "image":
        said({ kind: "image", key, image: part.image });
        return;
      case "tool-call":
        work(key).push({ kind: "tool", key: part.toolCallId, part });
        return;
      case "audio":
      case "data":
      case "file":
      case "generative-ui":
      case "source":
        return;
    }
  });
  return segments;
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

/** What a running thought says now, as a running turn's header would: see `liveHeadline`. */
export function liveThoughtHeadline(text: string): string {
  const section = thoughtSections(text).at(-1);
  if (section === undefined) {
    return "Thinking";
  }
  return section.written
    ? section.headline
    : clip(latestSentence(section.text) ?? section.headline);
}

/**
 * What the agent is doing now, for the header of a running activity card: the newest thought's
 * headline, or for prose its newest finished sentence, or the tool it runs.
 */
export function liveHeadline(
  steps: readonly AgentTurnStep[],
  toolHeadline: (part: ToolCallPart) => string,
): string {
  const step = steps.at(-1);
  if (step === undefined) {
    return "Working";
  }
  if (step.kind === "thought") {
    return step.running && !step.written
      ? clip(latestSentence(step.text) ?? step.headline)
      : step.headline;
  }
  return toolHeadline(step.part);
}

/** Markdown as one line of plain text, for a preview of it. */
export function plainText(markdown: string) {
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
