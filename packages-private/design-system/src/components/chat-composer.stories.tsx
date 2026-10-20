import type { ReactNode } from "react";

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
