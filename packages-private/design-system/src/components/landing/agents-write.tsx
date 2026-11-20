import { Tabs } from "@base-ui/react/tabs";
import { useEffect, useState } from "react";

import { cn } from "../../cn";
import { ChatAssistantMessage, ChatUserMessage } from "../agents/chat-message";
import { Icon, type IconName } from "../icon";
import { LandingSection } from "./landing-section";
import { ai, AiCount, ask, code, PanelLabel, type Step, StepTag } from "./workflow-steps";

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
  /** How many times the workflow has run, where the demo's counter starts. */
  runs: number;
};

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
    runs: 1_284,
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
    runs: 412,
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
    runs: 96,
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
    runs: 52,
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
    runs: 2_731,
  },
];

// How long the demo's run dwells on each part of a workflow, so the steps that hand off to a model
// or a person visibly take longer than plain code.
const TRIGGER_MS = 700;
const STEP_MS = { code: 550, ai: 1300, ask: 2000 } satisfies Record<Step["kind"], number>;
const FINISHED_MS = 1800;

const runsFormatter = new Intl.NumberFormat("en-US");

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Shows the split the product rests on: the team's agent writes a workflow from a sentence, and
 * the workflow, not the agent, runs every time after. The two sit on either side of a seam at the
 * wordmark's angle, with the workflow running over and over on its side.
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
        >
          <Tabs.List aria-label="Teams" className="backoffice-scroll flex gap-7 overflow-x-auto">
            {PROCESSES.map((process) => (
              <Tabs.Tab
                key={process.id}
                value={process.id}
                className={(state) =>
                  cn(
                    "shrink-0 cursor-pointer border-b-2 pb-3 text-[11px] font-semibold tracking-[0.14em] uppercase transition-colors duration-150 outline-none focus-visible:text-[var(--bo-fg)]",
                    state.active
                      ? "border-[var(--bo-fg)] text-[var(--bo-fg)]"
                      : "border-transparent text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]",
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

/**
 * Where the demo's run is: at its trigger, at a step, or finished. Each run starts at the trigger
 * and walks the steps; a finished run waits a moment before the next one starts.
 */
type Run = {
  count: number;
  at: { kind: "trigger" } | { kind: "step"; index: number } | { kind: "finished" };
};

function ProcessPanel({ process }: { process: Process }) {
  const [changed, setChanged] = useState(false);
  // The page renders a finished run, so the server and a still visitor see every step done.
  const [run, setRun] = useState<Run>({ count: process.runs, at: { kind: "finished" } });
  const steps = changed
    ? [
        ...process.steps.slice(0, process.change.at),
        process.change.step,
        ...process.steps.slice(process.change.at),
      ]
    : process.steps;

  const dwell =
    run.at.kind === "trigger"
      ? TRIGGER_MS
      : run.at.kind === "step"
        ? STEP_MS[steps[run.at.index].kind]
        : FINISHED_MS;
  useEffect(() => {
    if (prefersReducedMotion()) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setRun(nextRun(run, steps.length));
    }, dwell);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [run, dwell, steps.length]);

  return (
    // From xl, the agent's side is cut from the workflow's along a slant at the wordmark's angle.
    // The stage has a fixed height, so the slant's run can be computed from it.
    <div className="relative isolate mt-6 grid border border-[color:var(--bo-border)] bg-[var(--bo-panel)] [--seam-height:36rem] [--seam:calc(var(--seam-height)*tan(24.83deg))] xl:h-[var(--seam-height)] xl:grid-cols-2">
      {/* The seam: the agent's side over a copy of itself 1px wider, in the border color. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 hidden bg-[var(--bo-border)] [clip-path:polygon(0_0,calc(50%+var(--seam)/2+1px)_0,calc(50%-var(--seam)/2+1px)_100%,0_100%)] xl:block"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 hidden bg-[var(--bo-panel-2)] [clip-path:polygon(0_0,calc(50%+var(--seam)/2)_0,calc(50%-var(--seam)/2)_100%,0_100%)] xl:block"
      />

      {/* The agent's side narrows towards the bottom, so its chat keeps clear of the seam. */}
      <div className="flex min-w-0 flex-col border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-5 sm:p-8 xl:border-b-0 xl:bg-transparent">
        <PanelLabel>Agents write it</PanelLabel>
        <div className="mt-6 xl:max-w-[26rem]">
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
          <div className="mt-auto pt-2">
            <p className="text-xs text-[var(--bo-muted-2)]">Later, you ask</p>
            {/* Slanted like the page's calls to action, in their light gray. */}
            <button
              type="button"
              className="mt-2 inline-flex min-h-10 cursor-pointer items-center gap-2 bg-[#e6e3df] px-7 py-2 text-left text-sm transition-colors duration-150 outline-none [clip-path:polygon(0.5rem_0,100%_0,calc(100%-0.5rem)_100%,0_100%)] hover:bg-[#dcd8d3] focus-visible:bg-[#dcd8d3]"
              onClick={() => {
                setChanged(true);
                // The next run already follows the changed workflow.
                setRun((current) => ({ count: current.count + 1, at: { kind: "trigger" } }));
              }}
            >
              “{process.change.request}”
              <Icon name="corner-down-left" className="size-3.5 shrink-0" />
            </button>
          </div>
        )}
      </div>

      {/* The workflow's side widens towards the bottom, so its steps sit there, clear of the seam,
          under the count of runs that followed them. */}
      <div className="flex min-w-0 flex-col p-5 sm:p-8 xl:pl-[calc(var(--seam)*0.15+2rem)]">
        {/* Right-aligned, where the seam leaves this side narrowest. */}
        <div className="xl:text-right">
          <PanelLabel>Workflows run it</PanelLabel>
          <div className="mt-6">
            <p className="font-heading text-[clamp(2.25rem,3.6vw,3.25rem)] leading-none font-light tracking-[-0.05em] tabular-nums">
              {runsFormatter.format(run.count)}
            </p>
            <p className="mt-2 text-xs text-[var(--bo-muted)]">runs, every one the same steps</p>
          </div>
        </div>

        <div className="mt-8 xl:mt-auto">
          <p className="truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
            {process.workflow}.workflow.js
          </p>
          <div
            className={cn(
              "mt-2 flex items-center gap-2.5 border border-l-2 border-[color:var(--bo-border)] px-4 py-2.5 text-sm transition-colors duration-200",
              run.at.kind === "trigger"
                ? "border-l-[var(--bo-accent)] bg-[var(--bo-panel-2)]"
                : "border-l-[color:var(--bo-border)]",
            )}
          >
            <Icon
              name={process.trigger.icon}
              className="size-4 shrink-0 text-[var(--bo-accent-strong)]"
            />
            {process.trigger.text}
          </div>
          <ol className="border-x border-b border-[color:var(--bo-border)]">
            {steps.map((step, index) => (
              <LiveStepRow
                key={step.text}
                step={step}
                number={index + 1}
                progress={stepProgress(run, index)}
                added={changed && step === process.change.step}
              />
            ))}
          </ol>
          <p className="mt-4 text-xs leading-5 text-[var(--bo-muted)]">
            <AiCount steps={steps} />
          </p>
        </div>
      </div>
    </div>
  );
}

function nextRun(run: Run, stepCount: number): Run {
  switch (run.at.kind) {
    case "trigger":
      return { count: run.count, at: { kind: "step", index: 0 } };
    case "step":
      return {
        count: run.count,
        at:
          run.at.index + 1 < stepCount
            ? { kind: "step", index: run.at.index + 1 }
            : { kind: "finished" },
      };
    case "finished":
      return { count: run.count + 1, at: { kind: "trigger" } };
    default:
      throw new Error("Unsupported run position.", { cause: run.at satisfies never });
  }
}

type StepProgress = "done" | "running" | "pending";

function stepProgress(run: Run, index: number): StepProgress {
  switch (run.at.kind) {
    case "trigger":
      return "pending";
    case "step":
      return index < run.at.index ? "done" : index === run.at.index ? "running" : "pending";
    case "finished":
      return "done";
    default:
      throw new Error("Unsupported run position.", { cause: run.at satisfies never });
  }
}

function LiveStepRow({
  step,
  number,
  progress,
  added,
}: {
  step: Step;
  number: number;
  progress: StepProgress;
  added: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 border-t border-l-2 border-t-[color:var(--bo-border)] px-4 py-2.5 text-sm transition-colors duration-200",
        progress === "running"
          ? "border-l-[var(--bo-accent)] bg-[var(--bo-panel-2)]"
          : added
            ? "border-l-[var(--bo-live)] bg-[var(--bo-live-bg)]"
            : "border-l-transparent",
        progress === "pending" ? "text-[var(--bo-muted)]" : null,
      )}
    >
      <span className="flex w-4 shrink-0 justify-center font-mono text-[11px] text-[var(--bo-muted-2)] tabular-nums">
        {progress === "done" ? (
          <Icon name="check" className="size-3.5 text-[var(--bo-live)]" strokeWidth={2.5} />
        ) : progress === "running" ? (
          <span className="size-2 animate-pulse rounded-full bg-[var(--bo-accent)]" />
        ) : (
          number
        )}
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
