import { useState } from "react";
import { Link } from "react-router";

import { Button } from "../button";
import { Icon, type IconName } from "../icon";
import { BackofficeStatusLight } from "../status-light";
import type { BackofficeStatusTone } from "../status-tone";
import { LandingSection } from "./landing-section";

type Connection = {
  name: string;
  icon: IconName;
  kind: string;
  /** What the connection reaches or last did. */
  detail: string;
  status: { tone: BackofficeStatusTone; label: string };
};

// Each kind of connection Backoffice supports, shown with a service people already use.
const CONNECTIONS: readonly Connection[] = [
  {
    name: "Slack",
    icon: "slack",
    kind: "Web API",
    detail: "Posts to #sales",
    status: { tone: "live", label: "Connected" },
  },
  {
    name: "HubSpot",
    icon: "users",
    kind: "HTTP API",
    detail: "Contacts and deals",
    status: { tone: "live", label: "Ready" },
  },
  {
    name: "Stripe",
    icon: "credit-card",
    kind: "MCP server",
    detail: "23 tools",
    status: { tone: "live", label: "Ready" },
  },
  {
    name: "GitHub",
    icon: "github",
    kind: "GitHub app",
    detail: "4 repositories",
    status: { tone: "live", label: "Connected" },
  },
  {
    name: "Calendly",
    icon: "calendar",
    kind: "Incoming webhook",
    detail: "Last booking 2 min ago",
    status: { tone: "live", label: "Receiving" },
  },
  {
    name: "Google Drive",
    icon: "folder",
    kind: "OAuth account",
    detail: "ada@harbor.test",
    status: { tone: "waiting", label: "Needs consent" },
  },
];

type MarketplacePackage = {
  slug: string;
  name: string;
  version: string;
  summary: string;
  /** What installing declares, counted the way the install tab lists it. */
  setsUp: string;
};

// Packages Backoffice ships in its own marketplace, with what each release declares.
const PACKAGES: readonly MarketplacePackage[] = [
  {
    slug: "slack-setup",
    name: "Slack setup",
    version: "1.2.0",
    summary: "Connect Slack for outbound messages and verified inbound app mentions.",
    setsUp: "1 skill",
  },
  {
    slug: "github-channel",
    name: "GitHub Channel",
    version: "1.3.0",
    summary: "Classify GitHub webhooks into automation-ready domain events.",
    setsUp: "5 event types, 5 routes",
  },
  {
    slug: "jira-setup",
    name: "Jira setup",
    version: "1.1.0",
    summary: "Connect Jira Cloud and manage issues through its REST API.",
    setsUp: "1 skill",
  },
];

const columnLabelClassName =
  "px-5 pt-5 pb-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase";

/**
 * The tools a workspace works with: its own connections beside marketplace packages that set
 * connections, routes, and workflows up for it.
 */
export function LandingTools() {
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set());

  return (
    <LandingSection
      id="landing-tools"
      title="Use what you have, or start from a package."
      visual={
        <div className="grid gap-px border border-[color:var(--bo-border)] bg-[var(--bo-border)] lg:grid-cols-2">
          <div className="bg-[var(--bo-panel)]">
            <p className={columnLabelClassName}>Connected</p>
            <ul className="divide-y divide-[color:var(--bo-border)] border-t border-[color:var(--bo-border)]">
              {CONNECTIONS.map((connection) => (
                <li key={connection.name} className="flex min-w-0 items-center gap-3 px-5 py-3.5">
                  <span className="grid size-8 shrink-0 place-items-center bg-[var(--bo-panel-2)] text-[var(--bo-muted)]">
                    <Icon name={connection.icon} className="size-4" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold">{connection.name}</span>
                      <span className="hidden shrink-0 text-[11px] text-[var(--bo-muted-2)] sm:inline">
                        {connection.kind}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-[var(--bo-muted)]">
                      {connection.detail}
                    </span>
                  </span>
                  <BackofficeStatusLight tone={connection.status.tone}>
                    {connection.status.label}
                  </BackofficeStatusLight>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col bg-[var(--bo-panel-2)]">
            <p className={columnLabelClassName}>From the marketplace</p>
            <ul className="space-y-2 px-5">
              {PACKAGES.map((pkg) => (
                <li
                  key={pkg.slug}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold">{pkg.name}</span>
                        <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">
                          v{pkg.version}
                        </span>
                      </p>
                      <p className="mt-1 text-xs leading-5 text-pretty text-[var(--bo-muted)]">
                        {pkg.summary}
                      </p>
                      <p className="mt-2 text-[11px] text-[var(--bo-muted-2)]">
                        Sets up {pkg.setsUp}
                      </p>
                    </div>
                    <div className="shrink-0" aria-live="polite">
                      {installed.has(pkg.slug) ? (
                        <BackofficeStatusLight tone="live">Installed</BackofficeStatusLight>
                      ) : (
                        <Button
                          variant="secondary"
                          className="min-h-9 px-3 text-xs"
                          onClick={() => {
                            setInstalled((current) => new Set(current).add(pkg.slug));
                          }}
                        >
                          Install
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Link
              to="/marketplace"
              className="mt-auto flex items-center gap-2 px-5 pt-6 pb-5 text-sm font-medium text-[var(--bo-fg)] underline decoration-[var(--bo-border-strong)] underline-offset-[5px] hover:decoration-[var(--bo-fg)]"
            >
              Browse the marketplace
              <Icon name="arrow-right" className="size-3.5" />
            </Link>
          </div>
        </div>
      }
    >
      Connect Slack, HubSpot, GitHub, any MCP server or API, and webhooks from anywhere. Or install
      a package that sets up the connection, routes, and workflows for you, and shows you what it
      adds first.
    </LandingSection>
  );
}
