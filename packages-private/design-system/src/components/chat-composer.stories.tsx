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
      <SampleComposer running={false} disabledReason={null} queue={[]} />
    </Column>
  );
}

export function RunningWithQueue() {
  return (
    <Column>
      <SampleComposer
        running
        disabledReason={null}
        queue={[
          { label: "Steering", text: "Skip Acme, they paid this morning." },
          { label: "Up next", text: "Then summarize this week's revenue." },
          { label: "Notification", text: "stripe · invoice.overdue" },
        ]}
      />
    </Column>
  );
}

export function Disabled() {
  return (
    <Column>
      <SampleComposer running={false} disabledReason="This agent is read-only for you" queue={[]} />
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
