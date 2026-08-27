import { useState, type SubmitEvent } from "react";
import { Link, useOutletContext } from "react-router";

import type { BrowserRunSessions } from "@fragno-dev/cloudflare-fragment";

import {
  BackofficePageHeader,
  BackofficeStatusLight,
  FormContainer,
  FormField,
} from "@/components/backoffice";
import { cloudflareClient } from "@/fragno/cloudflare-client";

import type { Route } from "./+types/cloudflare-browser-run";
import { CloudflareCdpInspector } from "./cloudflare-cdp-inspector";
import { internalsScopeBasePath } from "./internals-scope";
import type { InternalsLayoutContext } from "./layout";

type BrowserSession = Awaited<ReturnType<BrowserRunSessions["list"]>>[number];
type BrowserTarget = Awaited<ReturnType<BrowserRunSessions["listTargets"]>>[number];

const controlClassName =
  "min-h-10 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-sm text-[var(--bo-fg)] outline-none transition-colors focus:border-[color:var(--bo-accent)]";
const primaryButtonClassName =
  "inline-flex min-h-10 items-center justify-center border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 text-[10px] font-semibold tracking-[0.2em] text-[var(--bo-accent-fg)] uppercase transition-[border-color,opacity,scale] hover:border-[color:var(--bo-accent-strong)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClassName =
  "inline-flex min-h-9 items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-muted)] uppercase transition-[border-color,color,scale] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";
const dangerButtonClassName =
  "inline-flex min-h-9 items-center justify-center border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 text-[10px] font-semibold tracking-[0.18em] text-[var(--bo-failed)] uppercase transition-[opacity,scale] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50";
const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
});

const formatTimestamp = (value?: number) => {
  if (!value) {
    return "—";
  }

  return timestampFormatter.format(new Date(value));
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : error ? String(error) : null;

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Backoffice Internals · Browser Run" },
    {
      name: "description",
      content: "Create and inspect Cloudflare Browser Run sessions and targets.",
    },
  ];
}

function SessionTargets({ sessionId }: { sessionId: string }) {
  const targetsQuery = cloudflareClient.useBrowserRunTargets({ path: { sessionId } });
  const createTarget = cloudflareClient.useCreateBrowserRunTarget();
  const activateTarget = cloudflareClient.useActivateBrowserRunTarget();
  const closeTarget = cloudflareClient.useCloseBrowserRunTarget();
  const [url, setUrl] = useState("https://fragno.dev");
  const [inspectedTarget, setInspectedTarget] = useState<BrowserTarget | null>(null);
  const [refreshingTargetId, setRefreshingTargetId] = useState<string | null>(null);
  const [targetOperationError, setTargetOperationError] = useState<string | null>(null);

  const targets = targetsQuery.data ?? [];
  const visibleInspectedTarget =
    inspectedTarget && targets.some((target: BrowserTarget) => target.id === inspectedTarget.id)
      ? inspectedTarget
      : null;
  const busy = Boolean(
    createTarget.loading || activateTarget.loading || closeTarget.loading || refreshingTargetId,
  );
  const operationError =
    targetOperationError ??
    errorMessage(createTarget.error) ??
    errorMessage(activateTarget.error) ??
    errorMessage(closeTarget.error) ??
    errorMessage(targetsQuery.error);

  const handleCreateTarget = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    await createTarget.mutate({
      path: { sessionId },
      body: url.trim() ? { url: url.trim() } : {},
    });
  };

  const fetchFreshTarget = async (targetId: string) => {
    setRefreshingTargetId(targetId);
    setTargetOperationError(null);

    try {
      return await cloudflareClient.fetchBrowserRunTarget(sessionId, targetId);
    } catch (caughtError) {
      setTargetOperationError(errorMessage(caughtError) ?? "Could not refresh the browser target.");
      return null;
    } finally {
      setRefreshingTargetId(null);
    }
  };

  const handleInspectTarget = async (targetId: string) => {
    const target = await fetchFreshTarget(targetId);
    if (!target) {
      return;
    }
    if (!target.webSocketDebuggerUrl) {
      setTargetOperationError("Cloudflare did not return a CDP WebSocket URL for this target.");
      return;
    }

    setInspectedTarget(target);
  };

  const handleOpenDevTools = async (targetId: string) => {
    const devToolsWindow = window.open("about:blank", "_blank");
    if (!devToolsWindow) {
      setTargetOperationError("Allow pop-ups to open Cloudflare DevTools.");
      return;
    }
    devToolsWindow.opener = null;

    const target = await fetchFreshTarget(targetId);
    if (!target?.devtoolsFrontendUrl) {
      devToolsWindow.close();
      if (target) {
        setTargetOperationError("Cloudflare did not return a DevTools URL for this target.");
      }
      return;
    }

    devToolsWindow.location.replace(target.devtoolsFrontendUrl);
  };

  return (
    <FormContainer
      eyebrow="Browser targets"
      title="Tabs and debuggable targets"
      description="Open a tab, inspect its debugger endpoints, bring it forward, or close it."
    >
      <form
        className="flex flex-col gap-3 md:flex-row md:items-end"
        onSubmit={(event) => void handleCreateTarget(event)}
      >
        <div className="min-w-0 flex-1">
          <FormField label="Initial URL" hint="Leave empty to create a blank target.">
            <input
              className={controlClassName}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
              placeholder="https://fragno.dev"
              inputMode="url"
            />
          </FormField>
        </div>
        <button className={primaryButtonClassName} disabled={busy} type="submit">
          {createTarget.loading ? "Opening…" : "Open target"}
        </button>
      </form>

      {operationError ? (
        <p className="border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] p-3 text-sm text-[var(--bo-failed)]">
          {operationError}
        </p>
      ) : null}

      {targetsQuery.loading && targets.length === 0 ? (
        <p className="text-sm text-[var(--bo-muted)]">Loading targets…</p>
      ) : targets.length === 0 ? (
        <p className="border border-dashed border-[color:var(--bo-border)] p-4 text-sm text-[var(--bo-muted)]">
          No targets are currently reported for this session.
        </p>
      ) : (
        <div className="space-y-2">
          {targets.map((target: BrowserTarget) => (
            <article
              key={target.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <BackofficeStatusLight tone="live">{target.type}</BackofficeStatusLight>
                    <code className="text-xs text-[var(--bo-muted)]">{target.id}</code>
                  </div>
                  <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                    {target.title || "Untitled target"}
                  </p>
                  <p className="text-xs break-all text-[var(--bo-muted)]">{target.url}</p>
                  {target.webSocketDebuggerUrl ? (
                    <p className="text-xs break-all text-[var(--bo-muted-2)]">
                      CDP: {target.webSocketDebuggerUrl}
                    </p>
                  ) : null}
                  {target.devtoolsFrontendUrl ? (
                    <button
                      className="inline-block text-xs font-semibold text-[var(--bo-accent-fg)] underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={busy}
                      type="button"
                      onClick={() => void handleOpenDevTools(target.id)}
                    >
                      {refreshingTargetId === target.id ? "Refreshing DevTools…" : "Open DevTools"}
                    </button>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {target.webSocketDebuggerUrl ? (
                    <button
                      className={primaryButtonClassName}
                      disabled={busy}
                      type="button"
                      onClick={() => void handleInspectTarget(target.id)}
                    >
                      {refreshingTargetId === target.id ? "Refreshing…" : "Inspect CDP"}
                    </button>
                  ) : null}
                  <button
                    className={secondaryButtonClassName}
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void activateTarget.mutate({
                        path: { sessionId, targetId: target.id },
                      })
                    }
                  >
                    Activate
                  </button>
                  <button
                    className={dangerButtonClassName}
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void closeTarget.mutate({
                        path: { sessionId, targetId: target.id },
                      })
                    }
                  >
                    Close
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {visibleInspectedTarget?.webSocketDebuggerUrl ? (
        <CloudflareCdpInspector
          key={visibleInspectedTarget.webSocketDebuggerUrl}
          targetId={visibleInspectedTarget.id}
          targetTitle={visibleInspectedTarget.title}
          webSocketDebuggerUrl={visibleInspectedTarget.webSocketDebuggerUrl}
          onClose={() => {
            setInspectedTarget(null);
          }}
        />
      ) : null}
    </FormContainer>
  );
}

function SessionInspector({ session }: { session: BrowserSession }) {
  const sessionQuery = cloudflareClient.useBrowserRunSession({
    path: { sessionId: session.sessionId },
  });
  const detail = sessionQuery.data ?? session;

  return (
    <div className="space-y-4">
      <FormContainer
        eyebrow="Selected session"
        title={detail.sessionId}
        description="Cloudflare's current metadata for this Browser Run process."
      >
        {sessionQuery.error ? (
          <p className="text-sm text-[var(--bo-failed)]">{errorMessage(sessionQuery.error)}</p>
        ) : null}
        <dl className="grid gap-px overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-border)] sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Started", formatTimestamp(detail.startTime)],
            ["Last updated", formatTimestamp(detail.lastUpdated)],
            ["Connection", detail.connectionId ?? "Disconnected"],
            ["Close reason", detail.closeReasonText ?? detail.closeReason ?? "Active"],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 bg-[var(--bo-panel-2)] p-3">
              <dt className="text-[10px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
                {label}
              </dt>
              <dd className="mt-2 text-sm font-semibold break-all text-[var(--bo-fg)]">{value}</dd>
            </div>
          ))}
        </dl>
        {detail.webSocketDebuggerUrl ? (
          <p className="text-xs break-all text-[var(--bo-muted)]">
            Browser CDP: {detail.webSocketDebuggerUrl}
          </p>
        ) : null}
      </FormContainer>

      <SessionTargets sessionId={session.sessionId} />
    </div>
  );
}

export default function CloudflareBrowserRunInternals() {
  const { selectedRouteScope } = useOutletContext<InternalsLayoutContext>();
  const internalsBasePath = internalsScopeBasePath(selectedRouteScope);
  const sessionsQuery = cloudflareClient.useBrowserRunSessions({
    query: { limit: "100", offset: "0" },
  });
  const createSession = cloudflareClient.useCreateBrowserRunSession();
  const closeSession = cloudflareClient.useCloseBrowserRunSession();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [keepAlive, setKeepAlive] = useState("600000");
  const [recording, setRecording] = useState(false);
  const [lab, setLab] = useState(false);
  const [includeTargets, setIncludeTargets] = useState(true);

  const sessions = sessionsQuery.data ?? [];
  const selectedSession =
    sessions.find((session: BrowserSession) => session.sessionId === selectedSessionId) ?? null;
  const operationError =
    errorMessage(createSession.error) ??
    errorMessage(closeSession.error) ??
    errorMessage(sessionsQuery.error);

  const handleCreateSession = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createSession.loading) {
      return;
    }

    const created = (await createSession.mutate({
      body: {
        keep_alive: Number(keepAlive),
        recording,
        lab,
        targets: includeTargets,
      },
    })) as Awaited<ReturnType<BrowserRunSessions["create"]>>;
    setSelectedSessionId(created.sessionId);
  };

  const handleCloseSession = async (sessionId: string) => {
    await closeSession.mutate({ path: { sessionId } });
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
    }
  };

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: internalsBasePath },
          { label: "Browser Run" },
        ]}
        eyebrow="Cloudflare"
        title="Browser Run session console"
        description="Exercise the fragment's HTTP session and target lifecycle APIs without loading Playwright."
        actions={
          <Link className={secondaryButtonClassName} to={internalsBasePath}>
            Back to internals
          </Link>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(19rem,0.75fr)_minmax(0,1.25fr)]">
        <div className="space-y-4">
          <FormContainer
            eyebrow="Acquire browser"
            title="Start a session"
            description="The session remains billable until closed or timed out by Cloudflare."
          >
            <form className="space-y-3" onSubmit={(event) => void handleCreateSession(event)}>
              <FormField
                label="Keep alive"
                hint="Inactivity timeout in milliseconds, from 10,000 to 1,200,000."
              >
                <input
                  className={controlClassName}
                  type="number"
                  min={10_000}
                  max={1_200_000}
                  step={1_000}
                  required
                  value={keepAlive}
                  onChange={(event) => {
                    setKeepAlive(event.target.value);
                  }}
                />
              </FormField>

              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ["Record", recording, setRecording],
                  ["Lab", lab, setLab],
                  ["Targets", includeTargets, setIncludeTargets],
                ].map(([label, checked, setChecked]) => (
                  <label
                    key={String(label)}
                    className="flex min-h-10 cursor-pointer items-center justify-between gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 text-xs font-semibold tracking-[0.14em] text-[var(--bo-muted)] uppercase"
                  >
                    {label as string}
                    <input
                      type="checkbox"
                      checked={checked as boolean}
                      onChange={(event) => {
                        (setChecked as (value: boolean) => void)(event.target.checked);
                      }}
                    />
                  </label>
                ))}
              </div>

              <button
                className={`${primaryButtonClassName} w-full`}
                disabled={Boolean(createSession.loading)}
                type="submit"
              >
                {createSession.loading ? "Starting…" : "Start browser session"}
              </button>
            </form>
          </FormContainer>

          <FormContainer
            eyebrow="Active fleet"
            title={`${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
            description="Select a session to inspect its current targets."
          >
            {operationError ? (
              <p className="border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] p-3 text-sm text-[var(--bo-failed)]">
                {operationError}
              </p>
            ) : null}

            {sessionsQuery.loading && sessions.length === 0 ? (
              <p className="text-sm text-[var(--bo-muted)]">Loading sessions…</p>
            ) : sessions.length === 0 ? (
              <p className="border border-dashed border-[color:var(--bo-border)] p-4 text-sm text-[var(--bo-muted)]">
                No active Browser Run sessions. Start one above.
              </p>
            ) : (
              <div className="space-y-2">
                {sessions.map((session: BrowserSession) => {
                  const selected = session.sessionId === selectedSessionId;
                  return (
                    <article
                      key={session.sessionId}
                      className={`border p-3 transition-colors ${
                        selected
                          ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)]"
                          : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
                      }`}
                    >
                      <button
                        className="block w-full text-left"
                        type="button"
                        onClick={() => {
                          setSelectedSessionId(session.sessionId);
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <BackofficeStatusLight tone={session.endTime ? "waiting" : "live"}>
                            {session.endTime ? "Ended" : "Active"}
                          </BackofficeStatusLight>
                          <span className="text-[10px] text-[var(--bo-muted-2)]">
                            {formatTimestamp(session.startTime)}
                          </span>
                        </div>
                        <code className="mt-3 block text-xs break-all text-[var(--bo-fg)]">
                          {session.sessionId}
                        </code>
                      </button>
                      <button
                        className={`${dangerButtonClassName} mt-3 w-full`}
                        disabled={Boolean(closeSession.loading)}
                        type="button"
                        onClick={() => void handleCloseSession(session.sessionId)}
                      >
                        Close session
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </FormContainer>
        </div>

        {selectedSession ? (
          <SessionInspector session={selectedSession} />
        ) : (
          <div className="flex min-h-96 items-center justify-center border border-dashed border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-8 text-center">
            <div className="max-w-sm">
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Session inspector
              </p>
              <h2 className="mt-3 text-xl font-semibold text-[var(--bo-fg)]">
                Select an active browser
              </h2>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Its metadata, CDP endpoint, and browser targets will appear here.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
