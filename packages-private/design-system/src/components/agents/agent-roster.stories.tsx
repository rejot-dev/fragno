import type { ReactNode } from "react";

import { BackofficeStatusLight } from "../feedback/status-light";
import { AgentRosterList, AgentRosterSection, type AgentRosterEntry } from "./agent-roster";

export default { title: "Agents/Roster" };

const quietDay = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 3, 1, 0, 0, 2, 4, 1, 0, 0, 0, 0, 0, 0];
const busyDay = [1, 0, 0, 0, 0, 2, 4, 6, 9, 7, 5, 8, 6, 7, 9, 11, 8, 6, 4, 2, 1, 1, 0, 0];

function entry(
  agentName: string,
  displayName: string,
  fields: Partial<Omit<AgentRosterEntry, "agentName" | "displayName">>,
): AgentRosterEntry {
  return {
    agentName,
    displayName,
    description: "",
    to: `#${agentName}`,
    maintainer: "Defined in this workspace",
    status: null,
    activity: "Not started",
    turns: null,
    ...fields,
  };
}

const assistant = entry("assistant", "Assistant", {
  description:
    "General-purpose Leyway assistant that works with everything the person prompting it may use.",
  maintainer: "Built in",
  status: (
    <BackofficeStatusLight tone="live" role="status">
      Answering
    </BackofficeStatusLight>
  ),
  activity: "Answering",
  turns: { perBucket: busyDay, total: 104 },
});

const frontDesk = entry("front-desk", "Front Desk", {
  description:
    "Answers the team's questions about bookings, invoices, and customers, and drafts replies to customers for a person to send. It never sends email itself and asks before changing a booking.",
  activity: "Answered 12 minutes ago",
  turns: { perBucket: quietDay, total: 14 },
});

const bookkeeper = entry("bookkeeper", "Bookkeeper", {
  description:
    "Reconciles the bank feed against open invoices every night, books what matches, and leaves the rest for a person with the reason it could not match. Workflows hand it each day's statement; it reports what it booked to the assistant.",
  maintainer: "Installed by package bookkeeping",
  status: (
    <BackofficeStatusLight tone="info" dot={false} role="status">
      2 queued
    </BackofficeStatusLight>
  ),
  activity: "Answered 2 hours ago",
  turns: { perBucket: quietDay, total: 14 },
});

const receiptFiler = entry("receipt-filer", "Receipt Filer", {
  description:
    "Reads receipts forwarded to receipts@, extracts the supplier, date, and totals, and files them under the matching expense.",
  activity: "Failed 1 day ago",
});

const triage = entry("triage", "Triage", {
  description: "Reviews workflow failures and proposes fixes.",
  status: (
    <BackofficeStatusLight tone="waiting" role="status">
      Stopped
    </BackofficeStatusLight>
  ),
  activity: "Stopped",
});

const leadScorer = entry("lead-scorer", "Lead Scorer", {
  description:
    "Scores each new lead from the website form against the ideal customer profile and writes the score and its reasons to the CRM.",
  maintainer: "Installed by package hubspot-leads",
  activity: "Answered 4 minutes ago",
  turns: { perBucket: busyDay, total: 96 },
});

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-10">
      <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance text-[var(--bo-fg)]">
        Agents
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-pretty text-[var(--bo-muted)]">
        Write to an assistant. Agents in other groups take their work from assistants, workflows,
        and each other.
      </p>
      <div className="mt-10">{children}</div>
    </div>
  );
}

export function Overview() {
  return (
    <Page>
      <AgentRosterSection title="Assistants" description="Write to these in Leyway." count={2}>
        <AgentRosterList entries={[assistant, frontDesk]} />
      </AgentRosterSection>
      <AgentRosterSection title="Finance" description="Prompted by agents and workflows." count={2}>
        <AgentRosterList entries={[bookkeeper, receiptFiler]} />
      </AgentRosterSection>
      <AgentRosterSection
        title="Operations"
        description="Prompted by agents and workflows."
        count={1}
      >
        <AgentRosterList entries={[triage]} />
      </AgentRosterSection>
      <AgentRosterSection title="Sales" description="Prompted by agents and workflows." count={1}>
        <AgentRosterList entries={[leadScorer]} />
      </AgentRosterSection>
    </Page>
  );
}

export function OnlyTheBuiltInAssistant() {
  return (
    <Page>
      <AgentRosterSection title="Assistants" description="Write to these in Leyway." count={1}>
        <AgentRosterList
          entries={[{ ...assistant, status: null, activity: "Not started", turns: null }]}
        />
      </AgentRosterSection>
    </Page>
  );
}
