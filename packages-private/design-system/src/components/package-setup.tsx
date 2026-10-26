import type { ReactNode } from "react";

import { Icon, type IconName } from "./icon";
import { BackofficeStatusLight } from "./status-light";

export type PackageSetupAgent = {
  name: string;
  description: string;
  /** `provider/modelId`, or null for the preferred available model. */
  model: string | null;
  /** Permission grants such as `*` or `namespace.permission`. */
  permissions: readonly string[];
  instructions: string;
};

export type PackageSetupRoute = {
  id: string;
  name: string;
  enabled: boolean;
  trigger:
    | {
        kind: "event";
        source: string;
        eventType: string;
        /** The conditions an event must meet, in words; null when every such event matches. */
        condition: string | null;
      }
    | { kind: "schedule"; cadence: string };
  action: { label: string; target: string };
  /** Whom the route acts as; null for actions that only pass events along. */
  runsAs: { actor: string; grants: readonly string[] | "inherit" } | null;
};

export type PackageSetupEventType = {
  source: string;
  eventType: string;
  label: string;
  description: string | null;
  /** Top-level payload fields its schema names. */
  payloadFields: readonly string[];
};

/**
 * What installing a Marketplace release sets up in a workspace: the permissions the installer
 * approves, and the agents, routes, and event types Backoffice keeps in sync for the installation.
 */
export function PackageSetup({
  permissions,
  agents,
  routes,
  eventTypes,
}: {
  permissions: readonly string[];
  agents: readonly PackageSetupAgent[];
  routes: readonly PackageSetupRoute[];
  eventTypes: readonly PackageSetupEventType[];
}) {
  if (!permissions.length && !agents.length && !routes.length && !eventTypes.length) {
    return (
      <p className="text-sm leading-6 text-pretty text-[var(--bo-muted)]">
        Installing copies the package&apos;s files and sets up nothing else.
      </p>
    );
  }

  return (
    <div className="space-y-7">
      {permissions.length ? (
        <PackageSetupSection
          icon="key"
          title="Permissions"
          count={permissions.length}
          description="You approve these, and must hold each one. The package's routes and install workflow use them."
        >
          <GrantList grants={permissions} />
        </PackageSetupSection>
      ) : null}
      {agents.length ? (
        <PackageSetupSection
          icon="cpu"
          title="Agents"
          count={agents.length}
          description="Defined in the workspace and kept in sync with the package; only reinstalling changes them."
        >
          <ul className="space-y-3">
            {agents.map((agent) => (
              <li key={agent.name}>
                <AgentCard agent={agent} />
              </li>
            ))}
          </ul>
        </PackageSetupSection>
      ) : null}
      {routes.length ? (
        <PackageSetupSection
          icon="git-branch"
          title="Routes"
          count={routes.length}
          description="Run when their trigger fires. Members can turn them off, but not change them."
        >
          <ul className="divide-y divide-[color:var(--bo-border)] border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
            {routes.map((route) => (
              <li key={route.id}>
                <RouteRow route={route} />
              </li>
            ))}
          </ul>
        </PackageSetupSection>
      ) : null}
      {eventTypes.length ? (
        <PackageSetupSection
          icon="zap"
          title="Event types"
          count={eventTypes.length}
          description="Added to the workspace's event catalog, so routes can trigger on them."
        >
          <ul className="divide-y divide-[color:var(--bo-border)] border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
            {eventTypes.map((eventType) => (
              <li key={`${eventType.source}:${eventType.eventType}`}>
                <EventTypeRow eventType={eventType} />
              </li>
            ))}
          </ul>
        </PackageSetupSection>
      ) : null}
    </div>
  );
}

function PackageSetupSection({
  icon,
  title,
  count,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  count: number;
  description: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]">
          <Icon name={icon} className="size-3.5" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h4 className="flex items-baseline gap-2 text-sm font-semibold text-[var(--bo-fg)]">
            {title}
            <span className="font-mono text-[11px] font-medium text-[var(--bo-muted-2)]">
              {count}
            </span>
          </h4>
          <p className="mt-0.5 text-xs leading-5 text-pretty text-[var(--bo-muted)]">
            {description}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

function GrantList({ grants }: { grants: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {grants.map((grant) => {
        const separator = grant.indexOf(".");
        return (
          <li
            key={grant}
            className="bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[11px] text-[var(--bo-fg)] shadow-[inset_0_0_0_1px_var(--bo-border)]"
          >
            {separator === -1 ? (
              grant
            ) : (
              <>
                <span className="text-[var(--bo-muted)]">{grant.slice(0, separator + 1)}</span>
                {grant.slice(separator + 1)}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AgentCard({ agent }: { agent: PackageSetupAgent }) {
  const narrowsNothing = agent.permissions.includes("*");
  return (
    <article className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h5 className="font-mono text-sm font-semibold text-[var(--bo-fg)]">{agent.name}</h5>
          <span className="font-mono text-[11px] text-[var(--bo-muted)]">
            {agent.model ?? "Preferred model"}
          </span>
        </div>
        <p className="text-xs leading-5 text-pretty text-[var(--bo-muted)]">{agent.description}</p>
        <div>
          <p className="mb-1.5 text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
            Permissions
          </p>
          <p className="text-[11px] leading-5 text-pretty text-[var(--bo-muted)]">
            {narrowsNothing
              ? "Each turn runs with the permissions of whoever prompts it."
              : "Each turn runs with the permissions of whoever prompts it, narrowed to these:"}
          </p>
          {narrowsNothing ? null : (
            <div className="mt-1.5">
              <GrantList grants={agent.permissions} />
            </div>
          )}
        </div>
      </div>
      {agent.instructions ? (
        <details className="group/instructions border-t border-[color:var(--bo-border)]">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 px-3 marker:hidden">
            <span className="text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
              Instructions
            </span>
            <Icon
              name="chevron-down"
              className="size-3.5 text-[var(--bo-muted-2)] transition-transform duration-150 ease-out group-open/instructions:rotate-180"
            />
          </summary>
          <pre className="max-h-72 overflow-auto border-t border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap text-[var(--bo-fg)]">
            {agent.instructions}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function RouteRow({ route }: { route: PackageSetupRoute }) {
  const { trigger, action, runsAs } = route;
  return (
    <article className="space-y-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h5 className="text-xs leading-5 font-semibold text-pretty text-[var(--bo-fg)]">
          {route.name}
        </h5>
        <span className="flex items-center gap-2">
          {route.enabled ? null : (
            <BackofficeStatusLight tone="muted" dot={false}>
              Starts off
            </BackofficeStatusLight>
          )}
          <span className="font-mono text-[10px] leading-5 text-[var(--bo-muted-2)]">
            {route.id}
          </span>
        </span>
      </div>
      <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[11px] leading-5">
        <RouteClause label="When">
          {trigger.kind === "event" ? (
            <>
              <code className="bg-[var(--bo-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--bo-fg)]">
                {trigger.source} · {trigger.eventType}
              </code>
              {trigger.condition ? (
                <span className="ml-1.5 text-[var(--bo-muted)]">if {trigger.condition}</span>
              ) : null}
            </>
          ) : (
            <span className="text-[var(--bo-fg)]">{trigger.cadence}</span>
          )}
        </RouteClause>
        <RouteClause label="Then">
          <span className="text-[var(--bo-fg)]">{action.label}</span>{" "}
          <code className="font-mono text-[10px] break-all text-[var(--bo-muted)]">
            {action.target}
          </code>
        </RouteClause>
        {runsAs ? (
          <RouteClause label="As">
            <span className="text-[var(--bo-fg)]">{runsAs.actor}</span>
            <span className="text-[var(--bo-muted)]">
              {runsAs.grants === "inherit" ? (
                ", with their own permissions"
              ) : runsAs.grants.length ? (
                <>
                  , with <span className="font-mono text-[10px]">{runsAs.grants.join(", ")}</span>
                </>
              ) : (
                ", with no permissions"
              )}
            </span>
          </RouteClause>
        ) : null}
      </dl>
    </article>
  );
}

function RouteClause({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-[9px] leading-5 font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
        {label}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function EventTypeRow({ eventType }: { eventType: PackageSetupEventType }) {
  return (
    <article className="space-y-1.5 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h5 className="text-xs leading-5 font-semibold text-[var(--bo-fg)]">{eventType.label}</h5>
        <code className="bg-[var(--bo-panel-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--bo-fg)]">
          {eventType.source} · {eventType.eventType}
        </code>
      </div>
      {eventType.description ? (
        <p className="text-[11px] leading-5 text-pretty text-[var(--bo-muted)]">
          {eventType.description}
        </p>
      ) : null}
      {eventType.payloadFields.length ? (
        <p className="text-[11px] leading-5 text-[var(--bo-muted)]">
          <span className="mr-1.5 text-[9px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
            Payload
          </span>
          <span className="font-mono text-[10px] text-[var(--bo-fg)]">
            {eventType.payloadFields.join(", ")}
          </span>
        </p>
      ) : null}
    </article>
  );
}
