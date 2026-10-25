import { useEffect, useState, type ReactNode } from "react";

import {
  ChatActivity,
  ChatActivityNote,
  ChatActivityStep,
  ChatArtifactToggle,
} from "./chat-activity";
import { LabeledSection } from "./labeled-section";
import { ScrollablePre } from "./scrollable-pre";

export default { title: "Agents/Chat activity" };

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-3xl flex-col gap-6">{children}</div>;
}

function Thought({ children }: { children: string }) {
  return <p className="text-xs leading-6 text-[var(--bo-muted)]">{children}</p>;
}

type SampleStep =
  | { kind: "thought"; title: string; body: string; durationMs: number }
  | { kind: "note"; text: string }
  | {
      kind: "tool";
      icon: "code" | "file-text" | "book-open";
      title: string;
      detail: string;
      code: string;
      result: string;
      durationMs: number;
      failed: boolean;
    };

const STEPS: SampleStep[] = [
  {
    kind: "thought",
    title: "Finding the unpaid invoices",
    body: "The user wants every unpaid invoice and a reminder for each. Load the open invoices first, then check which are past due.",
    durationMs: 2_400,
  },
  {
    kind: "tool",
    icon: "book-open",
    title: "Skill loaded",
    detail: "invoice-reminders",
    code: '{ "path": "/starter/skills/invoice-reminders/SKILL.md" }',
    result: "# Invoice reminders",
    durationMs: 180,
    failed: false,
  },
  {
    kind: "tool",
    icon: "code",
    title: "codemode",
    detail: "invoices.unpaid()",
    code: "return await invoices.unpaid();",
    result: '[\n  "INV-4182",\n  "INV-4190",\n  "INV-4203"\n]',
    durationMs: 1_240,
    failed: false,
  },
  { kind: "note", text: "Three invoices are open. Drafting a reminder for each customer now." },
  {
    kind: "thought",
    title: "Drafting one reminder per customer",
    body: "Acme is 32 days overdue, so their reminder should be firmer than the others.",
    durationMs: 3_100,
  },
  {
    kind: "tool",
    icon: "code",
    title: "codemode",
    detail: "drafts.write()",
    code: "await drafts.write(reminders);",
    result: "Error: /workspace/drafts is read-only",
    durationMs: 640,
    failed: true,
  },
  {
    kind: "tool",
    icon: "code",
    title: "codemode",
    detail: "files.write()",
    code: "await files.write('/workspace/drafts/', reminders);",
    result: '{ "written": 3 }',
    durationMs: 910,
    failed: false,
  },
];

function renderStep(step: SampleStep, index: number, running: boolean) {
  if (step.kind === "note") {
    return <ChatActivityNote key={index}>{step.text}</ChatActivityNote>;
  }
  if (step.kind === "thought") {
    return (
      <ChatActivityStep
        key={index}
        icon={null}
        state={running ? "running" : "done"}
        title={step.title}
        detail={null}
        durationMs={running ? null : step.durationMs}
        outlined={false}
        actions={null}
      >
        <Thought>{step.body}</Thought>
      </ChatActivityStep>
    );
  }
  return (
    <ChatActivityStep
      key={index}
      icon={step.failed ? "alert-triangle" : step.icon}
      state={running ? "running" : step.failed ? "failed" : "done"}
      title={step.title}
      detail={step.detail}
      durationMs={running ? null : step.durationMs}
      outlined={step.icon === "book-open"}
      actions={null}
    >
      <ScrollablePre>{step.code}</ScrollablePre>
      {running ? null : (
        <LabeledSection label={step.failed ? "Error" : "Result"}>
          <ScrollablePre>{step.result}</ScrollablePre>
        </LabeledSection>
      )}
    </ChatActivityStep>
  );
}

function headlineOf(step: SampleStep) {
  if (step.kind === "thought") {
    return step.title;
  }
  if (step.kind === "note") {
    return step.text;
  }
  return step.icon === "book-open" ? `Loading the ${step.detail} skill` : `Running ${step.title}`;
}

const ARTIFACTS = (
  <ChatArtifactToggle icon="layout" label="Interface" labelled pressed={false} onClick={() => {}} />
);

/** Steps arrive one by one, then the turn settles and the card folds to its summary. */
export function Live() {
  const [shown, setShown] = useState(1);
  const [startedAt] = useState(() => new Date());
  const settled = shown > STEPS.length;

  useEffect(() => {
    if (settled) {
      return undefined;
    }
    const timeout = setTimeout(() => {
      setShown((current) => current + 1);
    }, 1_600);
    return () => {
      clearTimeout(timeout);
    };
  }, [settled, shown]);

  const steps = STEPS.slice(0, shown);
  const current = steps.at(-1);
  return (
    <Column>
      <button
        type="button"
        className="self-start text-xs text-[var(--bo-accent-fg)] underline"
        onClick={() => {
          setShown(1);
        }}
      >
        Replay
      </button>
      <ChatActivity
        status={
          settled || !current
            ? {
                kind: "settled",
                outcome: "done",
                durationMs: 11_400,
                note: "4 tools · 2 thoughts",
                failedSteps: 1,
              }
            : { kind: "running", headline: headlineOf(current), startedAt }
        }
        artifacts={settled ? ARTIFACTS : null}
      >
        {steps.map((step, index) => renderStep(step, index, !settled && index === shown - 1))}
      </ChatActivity>
    </Column>
  );
}

export function Settled() {
  return (
    <Column>
      <ChatActivity
        status={{
          kind: "settled",
          outcome: "done",
          durationMs: 42_000,
          note: "4 tools · 2 thoughts",
          failedSteps: 1,
        }}
        artifacts={ARTIFACTS}
      >
        {STEPS.map((step, index) => renderStep(step, index, false))}
      </ChatActivity>
      <ChatActivity
        status={{
          kind: "settled",
          outcome: "stopped",
          durationMs: 6_300,
          note: "1 tool · 1 thought",
          failedSteps: 0,
        }}
        artifacts={null}
      >
        {STEPS.slice(0, 2).map((step, index) => renderStep(step, index, false))}
      </ChatActivity>
      <ChatActivity
        status={{
          kind: "settled",
          outcome: "failed",
          durationMs: null,
          note: "1 thought",
          failedSteps: 0,
        }}
        artifacts={null}
      >
        {STEPS.slice(0, 1).map((step, index) => renderStep(step, index, false))}
      </ChatActivity>
    </Column>
  );
}

export function Running() {
  const [startedAt] = useState(() => new Date(Date.now() - 12_000));
  return (
    <Column>
      <ChatActivity
        status={{ kind: "running", headline: "Drafting one reminder per customer", startedAt }}
        artifacts={null}
      >
        {STEPS.slice(0, 5).map((step, index) => renderStep(step, index, index === 4))}
      </ChatActivity>
    </Column>
  );
}
