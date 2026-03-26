import { ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import { Link, useFetcher, useOutletContext, useSearchParams } from "react-router";

import { Collapsible } from "@base-ui/react";

import type { AutomationSimulationResult } from "@/fragno/automation";

import type { Route } from "./+types/scripts";
import { runAutomationScenario } from "./data";
import type {
  AutomationLayoutContext,
  AutomationScenarioItem,
  AutomationScenarioStepItem,
  AutomationScriptItem,
} from "./shared";
import {
  AutomationBadge,
  AutomationNotice,
  formatAutomationSource,
  formatTimestamp,
} from "./shared";

type ScriptsActionData = {
  ok: boolean;
  message: string;
  scenarioPath?: string;
  result?: AutomationSimulationResult | null;
};

type ScriptDetailView = "source" | "tests";

const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

const getScriptDetailView = (value: string | null): ScriptDetailView =>
  value === "tests" ? "tests" : "source";

const buildScriptLink = ({
  basePath,
  scriptId,
  view,
}: {
  basePath: string;
  scriptId: string;
  view?: ScriptDetailView;
}) => {
  const params = new URLSearchParams({
    script: scriptId,
  });

  if (view) {
    params.set("view", view);
  }

  return `${basePath}?${params.toString()}`;
};

const jsonStringify = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

const isEmptyJsonObject = (value: unknown) => {
  if (value == null) {
    return true;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.keys(value).length === 0;
};

function JsonPanel({
  title,
  value,
  compact = false,
}: {
  title: string;
  value: unknown;
  compact?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">{title}</p>
      <pre
        className={`backoffice-scroll mt-2 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)] ${compact ? "max-h-56" : "max-h-80"}`}
      >
        <code>{jsonStringify(value)}</code>
      </pre>
    </div>
  );
}

function PrettyCollapsible({
  title,
  subtitle,
  badge,
  defaultOpen = false,
  disabled = false,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (disabled) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] opacity-70">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-[var(--bo-fg)]">{title}</p>
              {badge ? <AutomationBadge>{badge}</AutomationBadge> : null}
              <AutomationBadge>Empty</AutomationBadge>
            </div>
            {subtitle ? <p className="mt-1 text-xs text-[var(--bo-muted)]">{subtitle}</p> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <Collapsible.Trigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bo-panel-2)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-[var(--bo-fg)]">{title}</p>
              {badge ? <AutomationBadge>{badge}</AutomationBadge> : null}
            </div>
            {subtitle ? <p className="mt-1 text-xs text-[var(--bo-muted)]">{subtitle}</p> : null}
          </div>
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-muted-2)]">
            <ChevronRight className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel keepMounted className={open ? "block" : "hidden"}>
          <div className="border-t border-[color:var(--bo-border)] p-4">{children}</div>
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  );
}

function ScriptDetailTabs({
  basePath,
  script,
  activeView,
}: {
  basePath: string;
  script: AutomationScriptItem;
  activeView: ScriptDetailView;
}) {
  const tabs = [
    {
      id: "source" as const,
      label: "Source",
    },
    {
      id: "tests" as const,
      label: "Tests",
    },
  ];

  return (
    <div
      role="tablist"
      aria-label={`Script detail tabs for ${script.name}`}
      className="flex flex-wrap items-center gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
    >
      {tabs.map((tab) => {
        const isActive = activeView === tab.id;

        return (
          <Link
            key={tab.id}
            to={buildScriptLink({ basePath, scriptId: script.id, view: tab.id })}
            role="tab"
            aria-selected={isActive}
            className={
              isActive
                ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
                : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

function ScenarioRunResult({ result }: { result: AutomationSimulationResult }) {
  const failedStep = result.transcript.steps.find((step) => step.status === "failed") ?? null;

  return (
    <div
      className={
        failedStep
          ? "space-y-4 border border-red-400/40 bg-red-500/8 p-4 text-sm text-red-700 dark:text-red-200"
          : "space-y-4 border border-emerald-400/40 bg-emerald-500/12 p-4 text-sm text-[var(--bo-muted)]"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <AutomationBadge tone={failedStep ? "neutral" : "success"}>
          {failedStep ? "Scenario failed" : "Scenario completed"}
        </AutomationBadge>
        <AutomationBadge>{pluralize(result.transcript.steps.length, "step")}</AutomationBadge>
        <AutomationBadge>
          {pluralize(result.transcript.totalBindingsRun, "binding")}
        </AutomationBadge>
        <AutomationBadge>
          {pluralize(result.transcript.totalCommandsRun, "command")}
        </AutomationBadge>
      </div>

      {failedStep ? <p>{failedStep.failure?.message}</p> : null}

      <div>
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Replies</p>
        {result.finalState.replies.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {result.finalState.replies.map((reply, index) => (
              <li
                key={`${reply.eventId}-${index}`}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-3 text-[var(--bo-fg)]"
              >
                {reply.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs">No replies were emitted.</p>
        )}
      </div>

      <PrettyCollapsible
        title="Raw transcript"
        subtitle="Full simulation output including transcript and final state."
      >
        <JsonPanel title="Transcript JSON" value={result} compact />
      </PrettyCollapsible>
    </div>
  );
}

function ScenarioStepCard({ step }: { step: AutomationScenarioStepItem }) {
  return (
    <PrettyCollapsible
      title={step.title ?? step.id}
      subtitle={`${formatAutomationSource(step.event.source)} · ${step.event.eventType}`}
      badge={`Step ${step.index + 1}`}
    >
      <div className="space-y-4">
        <dl className="grid gap-3 text-sm text-[var(--bo-muted)] md:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Occurred
            </dt>
            <dd className="mt-1 text-[var(--bo-fg)]">{formatTimestamp(step.event.occurredAt)}</dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Event id
            </dt>
            <dd className="mt-1 font-mono text-[11px] text-[var(--bo-fg)]">{step.event.id}</dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Matching scripts
            </dt>
            <dd className="mt-1 text-[var(--bo-fg)]">
              {step.matchedScriptKeys.length > 0 ? step.matchedScriptKeys.join(", ") : "None"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Bindings
            </dt>
            <dd className="mt-1 text-[var(--bo-fg)]">
              {step.matchedBindingIds.length > 0 ? step.matchedBindingIds.join(", ") : "None"}
            </dd>
          </div>
        </dl>

        <div className="grid gap-4 xl:grid-cols-3">
          <JsonPanel title="Actor JSON" value={step.event.actor} compact />
          <JsonPanel title="Payload JSON" value={step.event.payload} compact />
          <JsonPanel title="Subject JSON" value={step.event.subject} compact />
        </div>
      </div>
    </PrettyCollapsible>
  );
}

function ScenarioCard({
  scenario,
  selectedScriptLabel,
}: {
  scenario: AutomationScenarioItem;
  selectedScriptLabel?: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const actionData = fetcher.data;
  const result = actionData?.ok ? (actionData.result ?? null) : null;
  const isRunning = fetcher.state !== "idle";

  return (
    <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      <div className="border-b border-[color:var(--bo-border)] px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <AutomationBadge tone="accent">Simulator</AutomationBadge>
              <AutomationBadge>{pluralize(scenario.stepCount, "step")}</AutomationBadge>
              {scenario.sources.map((source) => (
                <AutomationBadge key={`${scenario.id}-${source}`}>
                  {formatAutomationSource(source)}
                </AutomationBadge>
              ))}
            </div>

            <div>
              <h3 className="text-xl font-semibold text-[var(--bo-fg)]">{scenario.name}</h3>
              <p className="mt-1 font-mono text-xs text-[var(--bo-muted-2)]">
                {scenario.relativePath}
              </p>
            </div>

            {scenario.description ? (
              <p className="max-w-3xl text-sm leading-6 text-[var(--bo-muted)]">
                {scenario.description}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2 text-xs text-[var(--bo-muted)]">
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1.5">
                Scripts: {scenario.relatedScriptKeys.join(", ") || "—"}
              </span>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1.5">
                Bindings: {scenario.relatedBindingIds.join(", ") || "—"}
              </span>
            </div>

            {selectedScriptLabel ? (
              <p className="text-xs text-[var(--bo-muted-2)]">
                This scenario replays the real workspace files involving {selectedScriptLabel}.
              </p>
            ) : null}
          </div>

          <fetcher.Form method="post" className="shrink-0">
            <input type="hidden" name="intent" value="run-scenario" />
            <input type="hidden" name="scenarioPath" value={scenario.relativePath} />
            <button
              type="submit"
              disabled={isRunning}
              className="inline-flex items-center gap-2 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-2.5 text-[11px] font-semibold tracking-[0.24em] text-[var(--bo-accent-fg)] uppercase disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Play className="h-3.5 w-3.5" />
              {isRunning ? "Running…" : "Run scenario"}
            </button>
          </fetcher.Form>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid gap-3 xl:grid-cols-3">
          <PrettyCollapsible
            title="Environment variables"
            disabled={isEmptyJsonObject(scenario.env)}
          >
            <pre className="backoffice-scroll overflow-auto font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
              <code>{jsonStringify(scenario.env)}</code>
            </pre>
          </PrettyCollapsible>
          <PrettyCollapsible
            title="Initial state"
            subtitle="Optional starting bindings, sessions, claims, replies, and emitted events."
            disabled={isEmptyJsonObject(scenario.initialState)}
          >
            <pre className="backoffice-scroll overflow-auto font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
              <code>{jsonStringify(scenario.initialState ?? {})}</code>
            </pre>
          </PrettyCollapsible>
          <PrettyCollapsible
            title="Command mocks"
            subtitle="Ordered mock command results used during simulation."
            disabled={isEmptyJsonObject(scenario.commandMocks)}
          >
            <pre className="backoffice-scroll overflow-auto font-mono text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
              <code>{jsonStringify(scenario.commandMocks ?? {})}</code>
            </pre>
          </PrettyCollapsible>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Scenario flow
              </p>
              <h4 className="mt-1 text-base font-semibold text-[var(--bo-fg)]">Steps</h4>
            </div>
            <AutomationBadge>{pluralize(scenario.steps.length, "step")}</AutomationBadge>
          </div>

          <div className="space-y-3">
            {scenario.steps.map((step) => (
              <ScenarioStepCard key={`${scenario.id}-${step.id}`} step={step} />
            ))}
          </div>
        </div>

        {actionData?.message ? (
          actionData.ok && result ? (
            <ScenarioRunResult result={result} />
          ) : (
            <AutomationNotice tone="error">
              <p className="text-[10px] tracking-[0.22em] uppercase">
                Could not run automation scenario
              </p>
              <p className="mt-2 text-sm">{actionData.message}</p>
            </AutomationNotice>
          )
        ) : null}
      </div>
    </div>
  );
}

function ScenarioList({
  scenarios,
  selectedScriptLabel,
}: {
  scenarios: AutomationScenarioItem[];
  selectedScriptLabel?: string;
}) {
  if (scenarios.length === 0) {
    return (
      <div className="border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 text-sm text-[var(--bo-muted)]">
        No simulator scenarios are linked to this script yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {scenarios.map((scenario) => (
        <ScenarioCard
          key={scenario.id}
          scenario={scenario}
          selectedScriptLabel={selectedScriptLabel}
        />
      ))}
    </div>
  );
}

function ScriptSourcePanel({ script }: { script: AutomationScriptItem }) {
  return (
    <div className="space-y-4">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          Filesystem location
        </p>
        <p className="mt-2 font-mono text-xs text-[var(--bo-fg)]">{script.absolutePath}</p>
      </div>

      <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
        <div className="border-b border-[color:var(--bo-border)] px-4 py-3">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Bash source
          </p>
        </div>
        <pre className="backoffice-scroll max-h-[42rem] overflow-auto px-4 py-4 font-mono text-xs break-words whitespace-pre-wrap text-[var(--bo-fg)]">
          <code>
            {script.scriptLoadError
              ? "# Script source unavailable"
              : script.script || "# Empty script"}
          </code>
        </pre>
      </div>
    </div>
  );
}

function ScriptTestsPanel({
  scenarios,
  scenariosError,
  selectedScript,
}: {
  scenarios: AutomationScenarioItem[];
  scenariosError: string | null;
  selectedScript: AutomationScriptItem;
}) {
  return scenariosError ? (
    <AutomationNotice tone="error">
      <p className="text-[10px] tracking-[0.22em] uppercase">Could not load automation scenarios</p>
      <p className="mt-2 text-sm">{scenariosError}</p>
    </AutomationNotice>
  ) : (
    <ScenarioList scenarios={scenarios} selectedScriptLabel={selectedScript.key} />
  );
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "").trim();
  const scenarioPath = String(formData.get("scenarioPath") ?? "").trim();

  if (intent !== "run-scenario") {
    return {
      ok: false,
      message: "Unknown scripts action.",
    } satisfies ScriptsActionData;
  }

  if (!scenarioPath) {
    return {
      ok: false,
      message: "Scenario path is required.",
    } satisfies ScriptsActionData;
  }

  const result = await runAutomationScenario(request, context, params.orgId, scenarioPath);

  if (!result.ok) {
    return {
      ok: false,
      message: result.error ?? "Unable to run automation scenario.",
      scenarioPath,
      result: null,
    } satisfies ScriptsActionData;
  }

  return {
    ok: true,
    message: "Scenario completed.",
    scenarioPath,
    result: result.result,
  } satisfies ScriptsActionData;
}

export default function BackofficeOrganisationAutomationScripts() {
  const { orgId, scripts, scriptsError, scenarios, scenariosError } =
    useOutletContext<AutomationLayoutContext>();
  const [searchParams] = useSearchParams();
  const selectedScriptId = searchParams.get("script")?.trim() ?? "";
  const selectedScript = scripts.find((script) => script.id === selectedScriptId) ?? null;
  const activeView = getScriptDetailView(searchParams.get("view"));
  const isDetailVisible = Boolean(selectedScript);
  const basePath = `/backoffice/automations/${orgId}/scripts`;
  const scenarioCounts = new Map(
    scripts.map((script) => [
      script.id,
      scenarios.filter((scenario) => scenario.relatedScriptIds.includes(script.id)).length,
    ]),
  );
  const visibleScenarios = selectedScript
    ? scenarios.filter((scenario) => scenario.relatedScriptIds.includes(selectedScript.id))
    : scenarios;
  const hasScriptLoadError = Boolean(scriptsError);

  if (hasScriptLoadError && scripts.length === 0) {
    return (
      <AutomationNotice tone="error">
        <p className="text-[10px] tracking-[0.22em] uppercase">Could not load automation scripts</p>
        <p className="mt-2 text-sm">{scriptsError}</p>
      </AutomationNotice>
    );
  }

  if (scripts.length === 0) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No automation scripts are defined in this organisation&apos;s workspace.
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {hasScriptLoadError ? (
        <AutomationNotice tone="error">
          <p className="text-[10px] tracking-[0.22em] uppercase">Could not load all scripts</p>
          <p className="mt-2 text-sm">{scriptsError}</p>
        </AutomationNotice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <div
          className={`${isDetailVisible ? "hidden lg:block" : "block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Scripts
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Workspace scripts</h2>
            </div>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
              {scripts.length} total
            </span>
          </div>

          <div className="mt-4 space-y-2">
            {scripts.map((script) => {
              const isSelected = script.id === selectedScriptId;
              const scenarioCount = scenarioCounts.get(script.id) ?? 0;
              const status = script.scriptLoadError
                ? "Error"
                : script.enabled
                  ? "Enabled"
                  : "Disabled";

              return (
                <Link
                  key={script.id}
                  to={buildScriptLink({
                    basePath,
                    scriptId: script.id,
                    view: isSelected ? activeView : undefined,
                  })}
                  aria-current={isSelected ? "page" : undefined}
                  className={
                    isSelected
                      ? "block border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 py-4 text-left text-[var(--bo-accent-fg)]"
                      : "block border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-4 py-4 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                        {script.name}
                      </p>
                      <p className="mt-1 truncate font-mono text-xs text-[var(--bo-muted-2)]">
                        {script.key}
                      </p>
                      <p className="mt-1 truncate font-mono text-[11px] text-[var(--bo-muted-2)]">
                        {script.path}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <AutomationBadge tone="accent">Workspace</AutomationBadge>
                      <AutomationBadge
                        tone={
                          script.scriptLoadError ? "error" : script.enabled ? "success" : "neutral"
                        }
                      >
                        {status}
                      </AutomationBadge>
                      <AutomationBadge>{pluralize(scenarioCount, "scenario")}</AutomationBadge>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        <div
          className={`${isDetailVisible ? "block" : "hidden lg:block"} border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
        >
          {selectedScript ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2 lg:hidden">
                    <Link
                      to={basePath}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Back to list
                    </Link>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <AutomationBadge tone="accent">Workspace</AutomationBadge>
                    <AutomationBadge>{selectedScript.engine}</AutomationBadge>
                    <AutomationBadge
                      tone={
                        selectedScript.scriptLoadError
                          ? "neutral"
                          : selectedScript.enabled
                            ? "success"
                            : "neutral"
                      }
                    >
                      {selectedScript.scriptLoadError
                        ? "Error"
                        : selectedScript.enabled
                          ? "Enabled"
                          : "Disabled"}
                    </AutomationBadge>
                  </div>
                  <div>
                    <h2 className="text-2xl font-semibold text-[var(--bo-fg)]">
                      {selectedScript.name}
                    </h2>
                    <p className="mt-1 font-mono text-xs text-[var(--bo-muted-2)]">
                      {selectedScript.key}
                    </p>
                  </div>
                </div>

                <dl className="grid gap-3 text-sm text-[var(--bo-muted)] sm:grid-cols-4">
                  <div>
                    <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Version
                    </dt>
                    <dd className="mt-1 font-semibold text-[var(--bo-fg)]">
                      v{selectedScript.version}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Relative path
                    </dt>
                    <dd className="mt-1 font-mono text-xs text-[var(--bo-fg)]">
                      {selectedScript.path}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                      Bindings
                    </dt>
                    <dd className="mt-1 font-semibold text-[var(--bo-fg)]">
                      {selectedScript.enabledBindingCount}/{selectedScript.bindingCount} enabled
                    </dd>
                  </div>
                </dl>
              </div>

              {selectedScript.scriptLoadError ? (
                <AutomationNotice tone="error">
                  <p className="text-[10px] tracking-[0.22em] uppercase">
                    Could not load script source
                  </p>
                  <p className="mt-2 text-sm whitespace-pre-wrap">
                    {selectedScript.scriptLoadError}
                  </p>
                </AutomationNotice>
              ) : null}

              <ScriptDetailTabs
                basePath={basePath}
                script={selectedScript}
                activeView={activeView}
              />

              {activeView === "tests" ? (
                <ScriptTestsPanel
                  scenarios={visibleScenarios}
                  scenariosError={scenariosError}
                  selectedScript={selectedScript}
                />
              ) : (
                <ScriptSourcePanel script={selectedScript} />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-6 text-sm text-[var(--bo-muted)]">
                Select a script to inspect its source or linked tests.
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
