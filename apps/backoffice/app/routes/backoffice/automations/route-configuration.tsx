import { Braces, CircleDot, GitBranch } from "lucide-react";
import type { ReactNode } from "react";

import type {
  AutomationActorMatcher,
  AutomationEventMatcher,
  AutomationRouteScopeTemplate,
  AutomationWorkflowEventTarget,
} from "@/fragno/automation/routing";

type AutomationRouteTarget = AutomationRouteScopeTemplate | AutomationWorkflowEventTarget;

const targetLabel = (target: AutomationRouteTarget) => {
  switch (target.kind) {
    case "system":
      return "System scope";
    case "org":
      return "Organization scope";
    case "project":
      return "Project scope";
    case "user":
      return "User scope";
    case "instance_id":
      return "Workflow instance";
    case "stored_instance_id":
      return "Stored workflow instance";
  }

  throw new Error("Unsupported automation route target kind.");
};

const targetRows = (target: AutomationRouteTarget) => {
  switch (target.kind) {
    case "system":
      return [];
    case "org":
      return [{ label: "Organization ID", value: target.orgIdTemplate }];
    case "project":
      return [
        { label: "Organization ID", value: target.orgIdTemplate },
        { label: "Project ID", value: target.projectIdTemplate },
      ];
    case "user":
      return [{ label: "User ID", value: target.userIdTemplate }];
    case "instance_id":
      return [{ label: "Instance ID", value: target.template }];
    case "stored_instance_id":
      return [{ label: "Storage key", value: target.keyTemplate }];
  }

  throw new Error("Unsupported automation route target kind.");
};

export function AutomationRouteTargetDetail({ target }: { target: AutomationRouteTarget }) {
  const rows = targetRows(target);

  return (
    <section className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="flex items-start justify-between gap-3 border-b border-[color:var(--bo-border)] px-3 py-2.5">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-violet-500/10 text-violet-700 dark:text-violet-300">
            <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
              Target
            </p>
            <p className="mt-1 text-xs font-medium text-[var(--bo-fg)]">{targetLabel(target)}</p>
          </div>
        </div>
        <code className="shrink-0 bg-violet-500/8 px-2 py-1 text-[8px] font-semibold tracking-[0.12em] text-violet-700 uppercase dark:text-violet-300">
          {target.kind}
        </code>
      </div>

      {rows.length > 0 ? (
        <dl className="divide-y divide-[color:var(--bo-border)]">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 px-3 py-2.5">
              <dt className="text-[9px] tracking-[0.14em] text-[var(--bo-muted-2)] uppercase">
                {row.label}
              </dt>
              <dd className="font-mono text-[11px] break-all text-[var(--bo-fg)]">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="px-3 py-3 text-[11px] leading-5 text-[var(--bo-muted)]">
          The event remains in the system scope.
        </p>
      )}
    </section>
  );
}

type AutomationEventMatcherOperator = Extract<AutomationEventMatcher, { path: string }>["op"];

const matcherOperatorLabel = (operator: AutomationEventMatcherOperator) => {
  switch (operator) {
    case "eq":
      return "equals";
    case "neq":
      return "does not equal";
    case "startsWith":
      return "starts with";
    case "includes":
      return "includes";
    case "exists":
      return "exists";
  }

  throw new Error("Unsupported automation event matcher operator.");
};

const matcherValueLabel = (value: unknown) => {
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
};

const actorMatcherRows = (matcher: AutomationActorMatcher) => [
  { label: "Participation", value: matcher.participation },
  { label: "Scope", value: matcher.scope },
  ...(matcher.source ? [{ label: "Source", value: matcher.source }] : []),
  ...(matcher.type ? [{ label: "Type", value: matcher.type }] : []),
  ...(matcher.id ? [{ label: "ID", value: matcher.id }] : []),
  ...("role" in matcher && matcher.role ? [{ label: "Role", value: matcher.role }] : []),
];

function ActorMatcherNode({ matcher }: { matcher: AutomationActorMatcher }) {
  return (
    <div className="py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 bg-sky-500/10 px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.14em] text-sky-700 uppercase dark:text-sky-300">
          actor
        </span>
        <p className="text-[10px] text-[var(--bo-muted)]">
          Match trusted actor provenance structurally
        </p>
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 border-l border-sky-500/25 pl-3">
        {actorMatcherRows(matcher).map((row) => (
          <div key={row.label} className="flex items-baseline gap-1.5">
            <dt className="text-[8px] tracking-[0.12em] text-[var(--bo-muted-2)] uppercase">
              {row.label}
            </dt>
            <dd className="font-mono text-[10px] text-[var(--bo-fg)]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function MatcherBranch({
  operator,
  description,
  tone,
  children,
}: {
  operator: "all" | "any" | "not";
  description: string;
  tone: "amber" | "red";
  children: ReactNode;
}) {
  const badgeClassName =
    tone === "red"
      ? "bg-red-500/10 text-red-700 dark:text-red-300"
      : "bg-amber-500/12 text-amber-700 dark:text-amber-300";
  const railClassName =
    tone === "red" ? "border-red-500/25" : "border-[color:var(--bo-border-strong)]";

  return (
    <div className="py-1">
      <div className="flex items-baseline gap-2">
        <span
          className={`shrink-0 px-1.5 py-0.5 text-[8px] font-semibold tracking-[0.14em] uppercase ${badgeClassName}`}
        >
          {operator}
        </span>
        <p className="text-[10px] text-[var(--bo-muted)]">{description}</p>
      </div>
      <div className={`mt-1.5 ml-1.5 border-l pl-3 ${railClassName}`}>{children}</div>
    </div>
  );
}

const matcherRenderEntries = (matchers: AutomationEventMatcher[]) => {
  const occurrenceByMatcher = new Map<string, number>();

  return matchers.map((matcher) => {
    const matcherIdentity = matcherValueLabel(matcher);
    const occurrence = occurrenceByMatcher.get(matcherIdentity) ?? 0;
    occurrenceByMatcher.set(matcherIdentity, occurrence + 1);

    return { key: `${matcherIdentity}:${occurrence}`, matcher };
  });
};

function MatcherGroup({
  operator,
  matchers,
}: {
  operator: "all" | "any";
  matchers: AutomationEventMatcher[];
}) {
  return (
    <MatcherBranch
      operator={operator}
      description={
        operator === "all" ? "Every condition must match" : "At least one condition must match"
      }
      tone="amber"
    >
      {matchers.length > 0 ? (
        <div className="space-y-0.5">
          {matcherRenderEntries(matchers).map(({ key, matcher }) => (
            <MatcherNode key={key} matcher={matcher} />
          ))}
        </div>
      ) : (
        <p className="py-1 text-[10px] text-[var(--bo-muted-2)]">No conditions</p>
      )}
    </MatcherBranch>
  );
}

function MatcherNode({ matcher }: { matcher: AutomationEventMatcher }) {
  if ("all" in matcher) {
    return <MatcherGroup operator="all" matchers={matcher.all} />;
  }
  if ("any" in matcher) {
    return <MatcherGroup operator="any" matchers={matcher.any} />;
  }

  if ("not" in matcher) {
    return (
      <MatcherBranch operator="not" description="The condition must not match" tone="red">
        <MatcherNode matcher={matcher.not} />
      </MatcherBranch>
    );
  }
  if ("actor" in matcher) {
    return <ActorMatcherNode matcher={matcher.actor} />;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5">
      <code className="min-w-0 bg-[var(--bo-panel-2)] px-1.5 py-0.5 text-[10px] break-all text-[var(--bo-fg)]">
        {matcher.path}
      </code>
      <span className="shrink-0 text-[9px] font-medium text-amber-700 dark:text-amber-300">
        {matcherOperatorLabel(matcher.op)}
      </span>
      {matcher.op !== "exists" ? (
        <code className="min-w-0 font-mono text-[10px] break-all text-[var(--bo-muted)]">
          {matcherValueLabel(matcher.value)}
        </code>
      ) : null}
    </div>
  );
}

export function AutomationEventMatcherDetail({
  matcher,
}: {
  matcher: AutomationEventMatcher | null;
}) {
  return (
    <section className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="flex items-start gap-2.5 border-b border-[color:var(--bo-border)] px-3 py-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-amber-500/10 text-amber-700 dark:text-amber-300">
          <Braces className="h-3.5 w-3.5" strokeWidth={1.8} />
        </span>
        <div>
          <p className="text-[9px] tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">Matcher</p>
          <p className="mt-1 text-xs font-medium text-[var(--bo-fg)]">
            {matcher ? "Conditional event match" : "All source events"}
          </p>
        </div>
      </div>

      <div className="px-3 py-2.5">
        {matcher ? (
          <MatcherNode matcher={matcher} />
        ) : (
          <div className="flex items-start gap-2 text-[11px] leading-5 text-[var(--bo-muted)]">
            <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--bo-muted-2)]" />
            <p>Every event matching this source and event type activates the route.</p>
          </div>
        )}
      </div>
    </section>
  );
}
