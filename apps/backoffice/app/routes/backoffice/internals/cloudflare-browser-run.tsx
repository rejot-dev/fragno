import { Button } from "@fragno-private/design-system/button";
import { Checkbox } from "@fragno-private/design-system/checkbox";
import { Field } from "@fragno-private/design-system/field";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfaceFacts,
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelRows,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useState, type SubmitEvent } from "react";

import type { BrowserRunSessions } from "@fragno-dev/cloudflare-fragment";

import { cloudflareClient } from "@/fragno/cloudflare-client";

import type { Route } from "./+types/cloudflare-browser-run";
import { CloudflareCdpInspector } from "./cloudflare-cdp-inspector";

type BrowserSession = Awaited<ReturnType<BrowserRunSessions["list"]>>[number];
type BrowserTarget = Awaited<ReturnType<BrowserRunSessions["listTargets"]>>[number];

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
    <>
      <SurfacePanel
        caption={`${targets.length} ${targets.length === 1 ? "target" : "targets"}`}
        actions={null}
      >
        <SurfacePanelBody>
          <form
            className="flex flex-col gap-3 md:flex-row md:items-end"
            onSubmit={(event) => void handleCreateTarget(event)}
          >
            <div className="min-w-0 flex-1">
              <Field label="Initial URL" description="Leave empty to create a blank target.">
                <Input
                  className="w-full"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                  }}
                  placeholder="https://fragno.dev"
                  inputMode="url"
                />
              </Field>
            </div>
            <Button variant="accent" disabled={busy} type="submit">
              {createTarget.loading ? "Opening…" : "Open target"}
            </Button>
          </form>
          {operationError ? (
            <div className="mt-3">
              <InlineAlert>{operationError}</InlineAlert>
            </div>
          ) : null}
        </SurfacePanelBody>

        {targetsQuery.loading && targets.length === 0 ? (
          <p className="border-t border-[color:var(--bo-border)] px-4 py-5 text-sm text-[var(--bo-muted)]">
            Loading targets…
          </p>
        ) : targets.length === 0 ? (
          <BackofficeSystemState
            tone="empty"
            title="No targets are reported for this session."
            description="Open a target above to load a page in this browser."
            flush
          />
        ) : (
          <ul className="divide-y divide-[color:var(--bo-border)] border-t border-[color:var(--bo-border)]">
            {targets.map((target: BrowserTarget) => (
              <li
                key={target.id}
                className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-start lg:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <BackofficeStatusLight tone="live">{target.type}</BackofficeStatusLight>
                    <code className="text-xs text-[var(--bo-muted-2)]">{target.id}</code>
                  </div>
                  <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                    {target.title || "Untitled target"}
                  </p>
                  <p className="text-xs break-all text-[var(--bo-muted)]">{target.url}</p>
                  {target.webSocketDebuggerUrl ? (
                    <p className="font-mono text-[11px] break-all text-[var(--bo-muted-2)]">
                      CDP: {target.webSocketDebuggerUrl}
                    </p>
                  ) : null}
                  {target.devtoolsFrontendUrl ? (
                    <button
                      className="text-xs font-semibold text-[var(--bo-accent-fg)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
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
                    <Button
                      variant="accent"
                      disabled={busy}
                      onClick={() => void handleInspectTarget(target.id)}
                    >
                      {refreshingTargetId === target.id ? "Refreshing…" : "Inspect CDP"}
                    </Button>
                  ) : null}
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void activateTarget.mutate({
                        path: { sessionId, targetId: target.id },
                      })
                    }
                  >
                    Activate
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void closeTarget.mutate({
                        path: { sessionId, targetId: target.id },
                      })
                    }
                  >
                    Close
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SurfacePanel>

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
    </>
  );
}

function SessionInspector({ session }: { session: BrowserSession }) {
  const sessionQuery = cloudflareClient.useBrowserRunSession({
    path: { sessionId: session.sessionId },
  });
  const detail = sessionQuery.data ?? session;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SurfacePanel caption={`Session ${detail.sessionId}`} actions={null}>
        {sessionQuery.error ? (
          <SurfacePanelBody>
            <InlineAlert>{errorMessage(sessionQuery.error)}</InlineAlert>
          </SurfacePanelBody>
        ) : null}
        <SurfaceFacts
          items={[
            { key: "started", label: "Started", value: formatTimestamp(detail.startTime) },
            { key: "updated", label: "Last updated", value: formatTimestamp(detail.lastUpdated) },
            {
              key: "connection",
              label: "Connection",
              value: detail.connectionId ?? "Disconnected",
            },
            {
              key: "close-reason",
              label: "Close reason",
              value: detail.closeReasonText ?? detail.closeReason ?? "Active",
            },
          ]}
        />
        {detail.webSocketDebuggerUrl ? (
          <p className="border-t border-[color:var(--bo-border)] px-4 py-3 font-mono text-[11px] break-all text-[var(--bo-muted)]">
            Browser CDP: {detail.webSocketDebuggerUrl}
          </p>
        ) : null}
      </SurfacePanel>

      <SessionTargets sessionId={session.sessionId} />
    </div>
  );
}

export default function CloudflareBrowserRunInternals() {
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
    <div className="grid gap-4 xl:grid-cols-[minmax(19rem,0.75fr)_minmax(0,1.25fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <SurfacePanel caption="Start a session" actions={null}>
          <SurfacePanelBody>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => void handleCreateSession(event)}
            >
              <p className="text-sm text-pretty text-[var(--bo-muted)]">
                Exercises the fragment&apos;s HTTP session and target lifecycle APIs without loading
                Playwright. A session stays billable until it is closed or Cloudflare times it out.
              </p>
              <Field
                label="Keep alive"
                description="Inactivity timeout in milliseconds, from 10,000 to 1,200,000."
              >
                <Input
                  className="w-full"
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
              </Field>

              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {(
                  [
                    ["Record", recording, setRecording],
                    ["Lab", lab, setLab],
                    ["Targets", includeTargets, setIncludeTargets],
                  ] as const
                ).map(([label, checked, setChecked]) => (
                  <Checkbox key={label} checked={checked} onCheckedChange={setChecked}>
                    {label}
                  </Checkbox>
                ))}
              </div>

              <div>
                <Button variant="accent" disabled={Boolean(createSession.loading)} type="submit">
                  {createSession.loading ? "Starting…" : "Start browser session"}
                </Button>
              </div>
            </form>
          </SurfacePanelBody>
        </SurfacePanel>

        <SurfacePanel
          caption={`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
          actions={null}
        >
          {operationError ? (
            <SurfacePanelBody>
              <InlineAlert>{operationError}</InlineAlert>
            </SurfacePanelBody>
          ) : null}

          {sessionsQuery.loading && sessions.length === 0 ? (
            <p className="border-t border-[color:var(--bo-border)] px-4 py-5 text-sm text-[var(--bo-muted)]">
              Loading sessions…
            </p>
          ) : sessions.length === 0 ? (
            <BackofficeSystemState
              tone="empty"
              title="No active Browser Run sessions."
              description="Start one above to inspect its targets."
              flush
            />
          ) : (
            <SurfacePanelRows>
              <ul className="divide-y divide-[color:var(--bo-border)]">
                {sessions.map((session: BrowserSession) => {
                  const selected = session.sessionId === selectedSessionId;
                  return (
                    <li key={session.sessionId} className="flex items-center gap-3 py-2.5">
                      <button
                        className="group min-w-0 flex-1 text-left"
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setSelectedSessionId(session.sessionId);
                        }}
                      >
                        <span
                          className={`block truncate font-mono text-xs font-semibold group-hover:underline ${
                            selected ? "text-[var(--bo-accent-fg)]" : "text-[var(--bo-fg)]"
                          }`}
                        >
                          {session.sessionId}
                        </span>
                        <span className="block text-xs text-[var(--bo-muted-2)]">
                          Started {formatTimestamp(session.startTime)}
                        </span>
                      </button>
                      <BackofficeStatusLight tone={session.endTime ? "waiting" : "live"}>
                        {session.endTime ? "Ended" : "Active"}
                      </BackofficeStatusLight>
                      <Button
                        variant="danger"
                        disabled={Boolean(closeSession.loading)}
                        onClick={() => void handleCloseSession(session.sessionId)}
                      >
                        Close
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </SurfacePanelRows>
          )}
        </SurfacePanel>
      </div>

      {selectedSession ? (
        <SessionInspector session={selectedSession} />
      ) : (
        <BackofficeSystemState
          tone="empty"
          label="Session inspector"
          title="Select a session to inspect it."
          description="Its metadata, CDP endpoint, and browser targets appear here."
        />
      )}
    </div>
  );
}
