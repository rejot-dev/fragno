import { cn } from "../../cn";

/**
 * What a step costs the reader's trust: plain code, a question for a model, or a stop for a
 * person. Workflows can only ask models to classify or extract, so an `ai` step is a question.
 */
export type Step = { kind: "code" | "ai" | "ask"; text: string };

export function code(text: string): Step {
  return { kind: "code", text };
}

export function ai(text: string): Step {
  return { kind: "ai", text };
}

export function ask(text: string): Step {
  return { kind: "ask", text };
}

export function StepRow({ step, number, added }: { step: Step; number: number; added: boolean }) {
  return (
    <li
      className={cn(
        "flex items-baseline gap-3 border-t border-l-2 border-t-[color:var(--bo-border)] px-4 py-3 text-sm first:border-t-0",
        added ? "border-l-[var(--bo-live)] bg-[var(--bo-live-bg)]" : "border-l-transparent",
      )}
    >
      <span className="w-4 shrink-0 font-mono text-[11px] text-[var(--bo-muted-2)] tabular-nums">
        {number}
      </span>
      <span className="min-w-0 flex-1">{step.text}</span>
      {added ? <StepTag className="text-[var(--bo-live)]">Added</StepTag> : null}
      {step.kind === "ai" ? (
        <StepTag className="bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]">AI</StepTag>
      ) : null}
      {step.kind === "ask" ? (
        <StepTag className="bg-[var(--bo-waiting-bg)] text-[var(--bo-waiting)]">
          Waits for you
        </StepTag>
      ) : null}
    </li>
  );
}

export function StepTag({ className, children }: { className: string; children: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function AiCount({ steps }: { steps: readonly Step[] }) {
  const questions = steps.filter((step) => step.kind === "ai").length;
  if (questions === 0) {
    return <>This workflow never calls a model.</>;
  }
  return (
    <>
      A model answers {questions} of {steps.length} steps. The rest is code you can read.
    </>
  );
}

export function PanelLabel({ children }: { children: string | string[] }) {
  return (
    <p className="text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
      {children}
    </p>
  );
}
