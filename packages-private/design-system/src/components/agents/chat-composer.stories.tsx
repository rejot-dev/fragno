import { useState, type ReactNode } from "react";

import { ChatComposer, ChatComposerModelMenu, ChatComposerToolbar } from "./chat-composer";
import { SampleComposer } from "./chat-story-support";

export default { title: "Agents/Chat composer" };

function Column({ children }: { children: ReactNode }) {
  return <div className="max-w-3xl">{children}</div>;
}

export function Idle() {
  return (
    <Column>
      <SampleComposer running={false} disabled={null} queue={[]} />
    </Column>
  );
}

export function RunningWithQueue() {
  return (
    <Column>
      <SampleComposer
        running
        disabled={null}
        queue={[
          { label: "Steering", text: "Skip Acme, they paid this morning." },
          { label: "Up next", text: "Then summarize this week's revenue." },
          { label: "Notification", text: "stripe · invoice.overdue" },
        ]}
      />
    </Column>
  );
}

const NOT_MESSAGED = "Receipt Filer takes work from agents and workflows, not messages.";

export function Disabled() {
  return (
    <Column>
      <SampleComposer
        running={false}
        disabled={{ reason: NOT_MESSAGED, paused: false }}
        queue={[]}
      />
    </Column>
  );
}

export function DisabledWhileWorking() {
  return (
    <Column>
      <SampleComposer
        running
        disabled={{ reason: NOT_MESSAGED, paused: false }}
        queue={[{ label: "Queued", text: "File the receipt Ada forwarded at 9:14." }]}
      />
    </Column>
  );
}

export function DisabledWhileStopped() {
  return (
    <Column>
      <SampleComposer
        running={false}
        disabled={{ reason: NOT_MESSAGED, paused: true }}
        queue={[{ label: "Paused", text: "File the receipt Ada forwarded at 9:14." }]}
      />
    </Column>
  );
}

const MODELS = [
  { value: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { value: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" },
] as const;

const EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

export function ModelAndEffort() {
  const [model, setModel] = useState<(typeof MODELS)[number]["value"]>("openai/gpt-6.1-sol");
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]["value"]>("medium");
  return (
    <Column>
      <ChatComposer disabled={false}>
        <ChatComposerToolbar
          start={
            <ChatComposerModelMenu
              disabled={false}
              model={model}
              models={MODELS}
              onModelChange={setModel}
              effort={effort}
              efforts={EFFORTS}
              onEffortChange={setEffort}
            />
          }
          end={null}
        />
      </ChatComposer>
    </Column>
  );
}
