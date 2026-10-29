import { Tabs } from "@base-ui/react/tabs";
import { useState } from "react";

import { cn } from "../../cn";
import { Button } from "../button";
import { ChatAssistantMessage, ChatUserMessage } from "../chat-message";
import { Icon, type IconName } from "../icon";
import { LandingSection } from "./landing-section";

/**
 * What a step costs the reader's trust: plain code, a question for a model, or a stop for a
 * person. Workflows can only ask models to classify or extract, so an `ai` step is a question.
 */
type Step = { kind: "code" | "ai" | "ask"; text: string };

type Change = { request: string; reply: string; at: number; step: Step };

type Process = {
  id: string;
  team: string;
  prompt: string;
  reply: string;
  workflow: string;
  trigger: { icon: IconName; text: string };
  steps: readonly Step[];
  change: Change;
};

function code(text: string): Step {
  return { kind: "code", text };
}

function ai(text: string): Step {
  return { kind: "ai", text };
}

function ask(text: string): Step {
  return { kind: "ask", text };
}

const PROCESSES: readonly Process[] = [
  {
    id: "support",
    team: "Support",
    prompt:
      "When a customer sends the support form, rate how urgent it is, open a Jira ticket, and post the urgent ones in #support.",
    reply:
      "I wrote triage-support. The model answers one question, how urgent is this, and the rest runs the same way every time.",
    workflow: "triage-support",
    trigger: { icon: "clipboard", text: "A customer sends the support form" },
    steps: [
      ai("How urgent is this?"),
      code("Open a Jira ticket"),
      code("Post urgent ones in #support"),
    ],
    change: {
      request: "Also send the customer their ticket number.",
      reply: "Added a last step that emails them the Jira key. No model involved.",
      at: 3,
      step: code("Email the customer their ticket number"),
    },
  },
  {
    id: "sales",
    team: "Sales",
    prompt:
      "When someone fills in our contact form, qualify them, add them to HubSpot, and tell sales on Slack. Show me replies before they go out.",
    reply:
      "I wrote qualify-lead. The model only decides whether it’s a real lead. The reply comes from your template, and the run waits for you before sending it.",
    workflow: "qualify-lead",
    trigger: { icon: "clipboard", text: "Someone answers the contact form" },
    steps: [
      ai("Is this a real lead?"),
      code("Add the contact to HubSpot"),
      code("Post the lead in #sales"),
      code("Fill in the reply template"),
      ask("You read the reply"),
      code("Send it by email"),
    ],
    change: {
      request: "Skip leads from free email addresses.",
      reply: "Added a check before HubSpot. It’s a list of domains, so no model is involved.",
      at: 1,
      step: code("Stop if the address is Gmail, Outlook, or Yahoo"),
    },
  },
  {
    id: "finance",
    team: "Finance",
    prompt:
      "When Stripe reports a failed payment, look up the customer and draft a friendly reminder. Ask me before it’s sent.",
    reply:
      "I wrote chase-payment. It doesn’t need a model at all: it looks the customer up, fills in a reminder, and waits for you.",
    workflow: "chase-payment",
    trigger: { icon: "credit-card", text: "Stripe reports a failed payment" },
    steps: [
      code("Look up the customer in Stripe"),
      code("Fill in the reminder"),
      ask("You read the reminder"),
      code("Email the customer"),
    ],
    change: {
      request: "Don’t chase anyone twice in one week.",
      reply: "Added a check that skips anyone reminded in the last seven days.",
      at: 1,
      step: code("Stop if they were reminded this week"),
    },
  },
  {
    id: "operations",
    team: "Operations",
    prompt:
      "Every Monday at 9, post last week’s new customers, cancellations, and revenue in #ops.",
    reply: "I wrote weekly-numbers. It’s arithmetic, so there’s no model in it.",
    workflow: "weekly-numbers",
    trigger: { icon: "clock", text: "Every Monday at 09:00" },
    steps: [
      code("Fetch last week’s subscriptions from Stripe"),
      code("Total what changed"),
      code("Post in #ops"),
    ],
    change: {
      request: "Compare it with the week before.",
      reply: "Added a step that fetches the week before and shows the difference.",
      at: 2,
      step: code("Compare with the week before"),
    },
  },
  {
    id: "engineering",
    team: "Engineering",
    prompt:
      "When a GitHub issue is opened, label it as a bug, feature, or question, and post bugs in #engineering.",
    reply:
      "I wrote sort-issues. The model picks bug, feature, or question, and the workflow does the labeling and posting.",
    workflow: "sort-issues",
    trigger: { icon: "github", text: "An issue is opened on GitHub" },
    steps: [
      ai("Bug, feature, or question?"),
      code("Label it on GitHub"),
      code("Post bugs in #engineering"),
    ],
    change: {
      request: "Ignore issues opened by bots.",
      reply: "Added a check on the author before anything else runs.",
      at: 0,
      step: code("Stop if a bot opened it"),
    },
  },
];

/**
 * Shows the split the product rests on: the team's agent writes a workflow from a sentence, and
 * the workflow, not the agent, runs every time after.
 */
export function LandingAgentsWrite() {
  const [processId, setProcessId] = useState(PROCESSES[0].id);

  return (
    <LandingSection
      id="landing-agents-write"
      title="Agents write it. Workflows run it."
      visual={
        <Tabs.Root
          value={processId}
          onValueChange={(value: string) => {
            setProcessId(value);
          }}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)]"
        >
          <Tabs.List
            aria-label="Teams"
            className="backoffice-scroll flex overflow-x-auto border-b border-[color:var(--bo-border)]"
          >
            {PROCESSES.map((process) => (
              <Tabs.Tab
                key={process.id}
                value={process.id}
                className={(state) =>
                  cn(
                    "shrink-0 cursor-pointer px-5 py-3 text-sm font-semibold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bo-accent)]",
                    state.active
                      ? "shadow-[inset_0_-2px_0_var(--bo-accent)]"
                      : "text-[var(--bo-muted)]",
                  )
                }
              >
                {process.team}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          {PROCESSES.map((process) => (
            <Tabs.Panel key={process.id} value={process.id}>
              <ProcessPanel process={process} />
            </Tabs.Panel>
          ))}
        </Tabs.Root>
      }
    >
      Tell your team’s agent how the work goes. It writes the workflow, connects the tools, and
      marks where you sign off. Every run after that follows the workflow, and AI only answers the
      questions the workflow asks it.
    </LandingSection>
  );
}

function ProcessPanel({ process }: { process: Process }) {
  const [changed, setChanged] = useState(false);
  const steps = changed
    ? [
        ...process.steps.slice(0, process.change.at),
        process.change.step,
        ...process.steps.slice(process.change.at),
      ]
    : process.steps;

  return (
    <div className="grid lg:grid-cols-2">
      <div className="flex min-w-0 flex-col border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 sm:p-6 lg:border-r lg:border-b-0">
        <PanelLabel>You told the {process.team} agent</PanelLabel>
        <div className="mt-5">
          <ChatUserMessage time={null} attachments={null}>
            <p>{process.prompt}</p>
          </ChatUserMessage>
          <ChatAssistantMessage
            author={{ name: `${process.team} agent`, time: null }}
            footer={null}
          >
            <p>{process.reply}</p>
          </ChatAssistantMessage>
          {changed ? (
            <>
              <ChatUserMessage time={null} attachments={null}>
                <p>{process.change.request}</p>
              </ChatUserMessage>
              <ChatAssistantMessage
                author={{ name: `${process.team} agent`, time: null }}
                footer={null}
              >
                <p>{process.change.reply}</p>
              </ChatAssistantMessage>
            </>
          ) : null}
        </div>
        {changed ? null : (
          <div className="mt-auto flex flex-wrap items-center gap-3 pt-2">
            <span className="text-xs text-[var(--bo-muted-2)]">Later:</span>
            <Button
              variant="secondary"
              className="h-auto min-h-9 text-left font-normal"
              onClick={() => {
                setChanged(true);
              }}
            >
              “{process.change.request}”
            </Button>
          </div>
        )}
      </div>

      <div className="min-w-0 p-4 sm:p-6">
        <div className="flex items-baseline justify-between gap-3">
          <PanelLabel>What runs every time</PanelLabel>
          <span className="truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
            {process.workflow}.workflow.js
          </span>
        </div>

        <div className="mt-5 flex items-center gap-2.5 border border-[color:var(--bo-border)] px-4 py-3 text-sm">
          <Icon
            name={process.trigger.icon}
            className="size-4 shrink-0 text-[var(--bo-accent-strong)]"
          />
          {process.trigger.text}
        </div>

        <ol className="border-x border-b border-[color:var(--bo-border)]">
          {steps.map((step, index) => (
            <StepRow
              key={step.text}
              step={step}
              number={index + 1}
              added={changed && step === process.change.step}
            />
          ))}
        </ol>

        <p className="mt-4 text-xs leading-5 text-[var(--bo-muted)]">
          <AiCount steps={steps} />
        </p>
      </div>
    </div>
  );
}

function StepRow({ step, number, added }: { step: Step; number: number; added: boolean }) {
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

function StepTag({ className, children }: { className: string; children: string }) {
  return (
    <span
      className={cn(
        "shrink-0 px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

function AiCount({ steps }: { steps: readonly Step[] }) {
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

function PanelLabel({ children }: { children: string | string[] }) {
  return (
    <p className="text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
      {children}
    </p>
  );
}
