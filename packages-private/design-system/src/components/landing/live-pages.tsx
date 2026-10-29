import { cn } from "../../cn";
import { DataTable } from "../data-table";
import { Icon } from "../icon";
import { Metric } from "../metric";
import { StackedBarChart } from "../stacked-bar-chart";
import { BackofficeStatusLight } from "../status-light";
import { LandingSection, LandingStage } from "./landing-section";

const LEAD_SOURCES = [
  { id: "forms", label: "Contact form" },
  { id: "hubspot", label: "HubSpot" },
  { id: "email", label: "Email" },
] as const;

const LEADS_PER_DAY = [
  { id: "mon", label: "Mon", values: { forms: 4, hubspot: 2, email: 3 } },
  { id: "tue", label: "Tue", values: { forms: 6, hubspot: 1, email: 2 } },
  { id: "wed", label: "Wed", values: { forms: 5, hubspot: 4, email: 1 } },
  { id: "thu", label: "Thu", values: { forms: 8, hubspot: 3, email: 2 } },
  { id: "fri", label: "Fri", values: { forms: 3, hubspot: 2, email: 2 } },
] as const;

const RECENT_LEADS = [
  { name: "Maya Chen", source: "Contact form", status: "Qualified", age: "4 min" },
  { name: "Juniper Dental", source: "HubSpot", status: "Waiting on you", age: "1 h" },
  { name: "Olive & Co.", source: "Email", status: "Qualified", age: "3 h" },
] as const;

const TABS = [
  { label: "Overview", pinned: false, active: false },
  { label: "Events", pinned: false, active: false },
  { label: "Leads", pinned: true, active: true },
] as const;

/** Shows a page an agent wrote: a dashboard tab that reads the workspace's live data. */
export function LandingLivePages() {
  return (
    <LandingSection
      id="landing-live-pages"
      title="Dashboards your agent builds."
      visual={
        <LandingStage>
          <div className="grid gap-3 lg:grid-cols-[0.3fr_0.7fr]">
            <div className="flex flex-col gap-3">
              <p className="ml-auto max-w-[92%] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-3 text-sm leading-6">
                Make me a page with this week&rsquo;s leads by source, and anything waiting on me.
              </p>
              <p className="text-sm leading-6 text-[var(--bo-muted)]">
                I added{" "}
                <code className="font-mono text-[12px] text-[var(--bo-fg)]">leads.page.js</code> and
                pinned it to your dashboard. It updates as new leads arrive.
              </p>
            </div>

            <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)]">
              <div className="flex items-end gap-1 border-b border-[color:var(--bo-border)] px-3 pt-2">
                {TABS.map((tab) => (
                  <span
                    key={tab.label}
                    className={cn(
                      "-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2 text-xs font-semibold",
                      tab.active
                        ? "border-[color:var(--bo-accent)] text-[var(--bo-fg)]"
                        : "border-transparent text-[var(--bo-muted)]",
                    )}
                  >
                    {tab.pinned ? <Icon name="bookmark" className="size-3" /> : null}
                    {tab.label}
                  </span>
                ))}
              </div>

              <div className="space-y-4 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Metric
                    tone="info"
                    label="Leads this week"
                    value="48"
                    detail="+12 on last week"
                  />
                  <Metric tone="live" label="Qualified" value="31" detail="65% of leads" />
                  <Metric
                    tone="waiting"
                    label="Waiting on you"
                    value="2"
                    detail="Approval needed"
                  />
                </div>
                <StackedBarChart
                  ariaLabel="Leads per day by source"
                  series={LEAD_SOURCES}
                  buckets={LEADS_PER_DAY}
                />
                <DataTable
                  caption="Recent leads"
                  columns={[
                    { key: "name", label: "Lead", align: "start" },
                    { key: "source", label: "Source", align: "start" },
                    { key: "status", label: "Status", align: "start" },
                    { key: "age", label: "Arrived", align: "end" },
                  ]}
                  rows={RECENT_LEADS}
                />
                <div className="flex items-center gap-3 text-[11px] text-[var(--bo-muted-2)]">
                  <BackofficeStatusLight tone="live">Live</BackofficeStatusLight>
                  Reads automation data in this workspace
                </div>
              </div>
            </div>
          </div>
        </LandingStage>
      }
    >
      Ask for a view of your business and the agent writes it as a page in your workspace. Pages
      read live data from your automations and stay pinned to your dashboard.
    </LandingSection>
  );
}
