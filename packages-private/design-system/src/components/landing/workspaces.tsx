import { useState } from "react";

import { cn } from "../../cn";
import { Icon, type IconName } from "../icon";
import { LandingSection } from "./landing-section";

type FileEntry = { name: string; kind: "folder" | "file"; depth: 0 | 1 };

type Scope = {
  id: string;
  label: string;
  /** Where the scope sits: your own, an organization, or a project inside one. */
  kind: "Personal" | "Organization" | "Project";
  depth: 0 | 1;
  files: readonly FileEntry[];
  contents: readonly { icon: IconName; label: string; value: string }[];
};

function folder(name: string): FileEntry {
  return { name, kind: "folder", depth: 0 };
}

function file(name: string, depth: 0 | 1 = 1): FileEntry {
  return { name, kind: "file", depth };
}

const SCOPES: readonly Scope[] = [
  {
    id: "personal",
    label: "ada@harbor.test",
    kind: "Personal",
    depth: 0,
    files: [
      file("AGENTS.md", 0),
      folder("notes"),
      file("weekly-review.md"),
      folder("pages"),
      file("calendar.page.js"),
    ],
    contents: [
      { icon: "message-circle", label: "Agents", value: "Assistant" },
      { icon: "zap", label: "Automations", value: "Daily calendar digest" },
      { icon: "link", label: "Connections", value: "Google Calendar" },
    ],
  },
  {
    id: "harbor",
    label: "Harbor Booking",
    kind: "Organization",
    depth: 0,
    files: [
      file("AGENTS.md", 0),
      file("MEMORY.md", 0),
      folder("automations"),
      file("qualify-lead.workflow.js"),
      file("notify-sales.workflow.js"),
      folder("pages"),
      file("leads.page.js"),
      folder("policies"),
      file("refunds.md"),
    ],
    contents: [
      { icon: "message-circle", label: "Agents", value: "Assistant, Sales" },
      { icon: "zap", label: "Automations", value: "12 routes, 3 schedules" },
      { icon: "link", label: "Connections", value: "Slack, HubSpot, Stripe, email" },
    ],
  },
  {
    id: "website",
    label: "Website",
    kind: "Project",
    depth: 1,
    files: [
      folder("automations"),
      file("publish-site.workflow.js"),
      folder("content"),
      file("pricing.md"),
      file("team.md"),
    ],
    contents: [
      { icon: "message-circle", label: "Agents", value: "Writer" },
      { icon: "zap", label: "Automations", value: "Publish on merge" },
      { icon: "link", label: "Connections", value: "GitHub" },
    ],
  },
  {
    id: "billing",
    label: "Billing",
    kind: "Project",
    depth: 1,
    files: [
      folder("automations"),
      file("approve-invoice.workflow.js"),
      folder("exports"),
      file("october.csv"),
      folder("invoices"),
      file("INV-2041.pdf"),
    ],
    contents: [
      { icon: "message-circle", label: "Agents", value: "Bookkeeper" },
      { icon: "zap", label: "Automations", value: "Approve invoices" },
      { icon: "link", label: "Connections", value: "Stripe" },
    ],
  },
];

/** Shows the scope switcher and what each scope holds, so switching visibly changes everything. */
export function LandingWorkspaces() {
  const [selectedId, setSelectedId] = useState("harbor");
  const selected = SCOPES.find((scope) => scope.id === selectedId) ?? SCOPES[0];

  return (
    <LandingSection
      id="landing-scopes"
      title="A space for you, your team, and each project."
      visual={
        <div className="grid border border-[color:var(--bo-border)] bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)] md:grid-cols-[0.36fr_0.64fr]">
          <div
            role="radiogroup"
            aria-label="Workspace"
            className="border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 md:border-r md:border-b-0"
          >
            {SCOPES.map((scope) => (
              <button
                key={scope.id}
                type="button"
                role="radio"
                aria-checked={scope.id === selected.id}
                onClick={() => {
                  setSelectedId(scope.id);
                }}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bo-accent)]",
                  scope.depth === 1 && "pl-9",
                  scope.id === selected.id
                    ? "bg-[var(--bo-panel)] shadow-[var(--bo-selected-shadow)]"
                    : "hover:bg-[var(--bo-panel)]",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{scope.label}</span>
                  <span className="block text-[11px] text-[var(--bo-muted-2)]">{scope.kind}</span>
                </span>
                {scope.id === selected.id ? (
                  <Icon name="check" className="size-3.5 text-[var(--bo-accent)]" />
                ) : null}
              </button>
            ))}
          </div>

          <div className="p-5 sm:p-6" aria-live="polite">
            <p className="text-[11px] text-[var(--bo-muted-2)]">{selected.kind}</p>
            <h3 className="mt-0.5 text-xl font-semibold tracking-[-0.02em]">{selected.label}</h3>
            <div className="mt-5 grid gap-px border border-[color:var(--bo-border)] bg-[var(--bo-border)] sm:grid-cols-[1.1fr_0.9fr]">
              <div className="bg-[var(--bo-panel)] p-4">
                <p className="mb-2 text-xs text-[var(--bo-muted)]">Files</p>
                <ul aria-label={`Files in ${selected.label}`} className="space-y-1">
                  {selected.files.map((entry) => (
                    <li
                      key={`${entry.kind}:${entry.name}`}
                      className={cn(
                        "flex items-center gap-2 text-[12px]",
                        entry.depth === 1 && "pl-5",
                        entry.kind === "file" && "font-mono text-[11px]",
                      )}
                    >
                      <Icon
                        name={entry.kind === "folder" ? "folder" : "file-text"}
                        className="size-3.5 shrink-0 text-[var(--bo-muted-2)]"
                        strokeWidth={1.8}
                      />
                      <span className="truncate">{entry.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <ul className="bg-[var(--bo-panel)]">
                {selected.contents.map((item) => (
                  <li
                    key={item.label}
                    className="flex gap-3 border-[color:var(--bo-border)] p-4 not-last:border-b"
                  >
                    <Icon
                      name={item.icon}
                      className="mt-0.5 size-4 shrink-0 text-[var(--bo-muted)]"
                      strokeWidth={1.8}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-[var(--bo-muted)]">{item.label}</span>
                      <span className="block text-sm">{item.value}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      }
    >
      Your personal workspace, each organization, and every project inside one have their own file
      system, agents, automations, and connections. Instructions, memory, pages, and everything your
      agents produce stay there across runs. Switch where you are, and everything follows.
    </LandingSection>
  );
}
