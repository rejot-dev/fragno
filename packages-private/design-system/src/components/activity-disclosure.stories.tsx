import { ActivityDisclosure } from "./activity-disclosure";
import { LabeledSection } from "./labeled-section";
import { ScrollablePre } from "./scrollable-pre";
import { SectionDisclosure } from "./section-disclosure";

export default { title: "Agents/Activity disclosure" };

const TIME = new Date("2026-10-20T09:41:07");

const TOOL_ARGUMENTS = `{
  "path": "/workspace/reports/q3-revenue.md"
}`;

const TOOL_RESULT = `# Q3 revenue

| Region | Revenue |
| ------ | ------- |
| EMEA   | €1.2M   |
| NA     | $2.4M   |`;

export function ToolCalls() {
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <ActivityDisclosure marker="progress" title="execCodeMode" detail="Running" time={TIME}>
        <ScrollablePre>{"await automations.list();"}</ScrollablePre>
      </ActivityDisclosure>
      <ActivityDisclosure
        marker="live"
        title="read"
        detail="/workspace/reports/q3-revenue.md"
        time={TIME}
      >
        <ScrollablePre>{TOOL_ARGUMENTS}</ScrollablePre>
        <LabeledSection label="Result">
          <ScrollablePre>{TOOL_RESULT}</ScrollablePre>
        </LabeledSection>
      </ActivityDisclosure>
      <ActivityDisclosure
        marker="live"
        outline="live"
        title="Skill loaded"
        detail="bookkeeping"
        time={TIME}
      >
        <ScrollablePre>{`{ "name": "bookkeeping" }`}</ScrollablePre>
      </ActivityDisclosure>
      <ActivityDisclosure marker="failed" outline="failed" title="bash" detail="Failed" time={TIME}>
        <ScrollablePre>{"ls: /workspace/missing: No such file or directory"}</ScrollablePre>
      </ActivityDisclosure>
    </div>
  );
}

export function ConversationEvents() {
  return (
    <div className="flex max-w-3xl flex-col gap-3 text-sm leading-7 text-[var(--bo-muted)]">
      <ActivityDisclosure marker="progress" title="Working" time={TIME} autoOpen>
        <p>Checking which invoices are still unpaid before drafting the reminder.</p>
      </ActivityDisclosure>
      <ActivityDisclosure marker={null} title="Reasoning" time={TIME}>
        <p>The customer asked for a summary, so a table is the clearest answer.</p>
      </ActivityDisclosure>
      <ActivityDisclosure marker="accent" title="Context compacted" note="Automatic" time={TIME}>
        <p>Pi continues from this summary instead of the history before it.</p>
      </ActivityDisclosure>
      <ActivityDisclosure
        marker="notification"
        title="github · issue.opened"
        note="via triage-route"
        time={TIME}
      >
        <pre className="text-xs leading-5 whitespace-pre-wrap">{`{ "issue": 4182 }`}</pre>
      </ActivityDisclosure>
    </div>
  );
}

export function WithSections() {
  return (
    <div className="max-w-3xl">
      <ActivityDisclosure marker="live" title="execCodeMode" detail="Done" time={TIME} autoOpen>
        <LabeledSection label="Result">
          <ScrollablePre>{"3 unpaid invoices"}</ScrollablePre>
        </LabeledSection>
        <SectionDisclosure label="Code">
          <ScrollablePre>{"return await invoices.unpaid();"}</ScrollablePre>
        </SectionDisclosure>
        <SectionDisclosure label="Logs">
          <ScrollablePre>{"Loaded 12 invoices\nFiltered to 3 unpaid"}</ScrollablePre>
        </SectionDisclosure>
        <SectionDisclosure label="Raw result">
          <ScrollablePre expanded>{TOOL_RESULT}</ScrollablePre>
        </SectionDisclosure>
      </ActivityDisclosure>
    </div>
  );
}
