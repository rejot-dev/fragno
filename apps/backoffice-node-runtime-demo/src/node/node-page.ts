import type {
  NodeDebugOverview,
  ObjectControlOverview,
} from "../inspection/object-control-overview";
import { describeObjectStatus, type ObjectStatus } from "../inspection/object-status";
import { demoObjectNamePattern } from "../objects/demo-object-definition";

/** Renders a read-only control snapshot without activating objects or refreshing their idle timers. */
export function renderNodePage(options: NodeDebugOverview & { applicationOrigin: string }): string {
  const objectViews = options.objects.map((object) => ({
    object,
    status: describeObjectStatus(object, options.generatedAtMs),
  }));
  const provisionedCount = objectViews.filter(({ object }) => object.location !== null).length;
  const activeCount = objectViews.filter(({ status }) => status.kind === "active").length;
  const attentionCount = objectViews.filter(
    ({ status, object }) =>
      status.kind === "owner-expired" ||
      status.kind === "owner-missing" ||
      status.kind === "control-inconsistent" ||
      object.alarmWork?.kind === "reconcile",
  ).length;
  const scheduledAlarmCount = objectViews.filter(
    ({ object }) => object.alarmWork?.kind === "scheduled",
  ).length;
  const nodeState = options.nodeAuthority.state;
  const nodeStateDetail =
    options.nodeAuthority.state === "serving"
      ? `lease ${formatNodePageRelativeTime(
          options.nodeAuthority.window.leaseExpiresAtEpochMs,
          options.generatedAtMs,
        )}`
      : options.nodeAuthority.state === "fenced"
        ? options.nodeAuthority.reason.kind
        : "authority closed";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Runtime control snapshot</title>
    <style>
      :root {
        color-scheme: light;
        --paper: #edf3f2;
        --surface: #f9fcfb;
        --surface-strong: #ffffff;
        --ink: #10252b;
        --muted: #5d7075;
        --line: #cbd8d6;
        --teal: #08756b;
        --blue: #28628f;
        --amber: #9a6711;
        --red: #a33c32;
        --slate: #68787d;
        --shadow: 0 16px 40px rgb(34 64 68 / 0.09), 0 2px 5px rgb(34 64 68 / 0.08);
      }
      * { box-sizing: border-box; }
      html { -webkit-font-smoothing: antialiased; }
      body {
        margin: 0;
        color: var(--ink);
        background:
          linear-gradient(rgb(255 255 255 / 0.45) 1px, transparent 1px),
          linear-gradient(90deg, rgb(255 255 255 / 0.45) 1px, transparent 1px),
          var(--paper);
        background-size: 24px 24px;
        font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      a { color: var(--teal); text-underline-offset: 3px; }
      a:hover { color: var(--ink); }
      a:focus-visible, summary:focus-visible {
        outline: 3px solid rgb(8 117 107 / 0.28);
        outline-offset: 3px;
        border-radius: 4px;
      }
      code, pre, .mono {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-variant-numeric: tabular-nums;
      }
      .shell { width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 36px 0 64px; }
      .masthead {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 24px;
        align-items: end;
        padding: 24px 0 26px;
        border-bottom: 2px solid var(--ink);
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--teal);
        font: 700 12px/1.2 "SFMono-Regular", Consolas, monospace;
        letter-spacing: 0.13em;
        text-transform: uppercase;
      }
      h1 { margin: 0; max-width: 760px; font-size: clamp(30px, 5vw, 58px); line-height: 0.98; letter-spacing: -0.045em; text-wrap: balance; }
      .masthead-copy { max-width: 720px; margin: 16px 0 0; color: var(--muted); font-size: 16px; text-wrap: pretty; }
      .snapshot-meta { text-align: right; }
      .snapshot-meta p { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
      .refresh-link {
        display: inline-flex;
        min-height: 40px;
        align-items: center;
        padding: 0 14px;
        border: 1px solid var(--ink);
        border-radius: 6px;
        color: var(--ink);
        background: var(--surface-strong);
        font-weight: 700;
        text-decoration: none;
        box-shadow: 3px 3px 0 var(--ink);
        transition-property: transform, box-shadow;
        transition-duration: 120ms;
      }
      .refresh-link:active { transform: translate(2px, 2px) scale(0.96); box-shadow: 1px 1px 0 var(--ink); }
      .node-strip {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 14px;
        align-items: center;
        margin: 22px 0;
        padding: 13px 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgb(249 252 251 / 0.88);
        box-shadow: var(--shadow);
      }
      .node-strip code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .node-detail { color: var(--muted); font-size: 13px; }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        width: fit-content;
        padding: 5px 9px;
        border-radius: 999px;
        color: var(--slate);
        background: rgb(104 120 125 / 0.1);
        font: 700 11px/1.2 "SFMono-Regular", Consolas, monospace;
        letter-spacing: 0.055em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .status::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; content: ""; }
      .status-active, .status-serving { color: var(--teal); background: rgb(8 117 107 / 0.1); }
      .status-restoring { color: var(--blue); background: rgb(40 98 143 / 0.1); }
      .status-unowned, .status-not-provisioned, .status-closed { color: var(--slate); }
      .status-owner-expired, .status-owner-missing, .status-control-inconsistent, .status-fenced { color: var(--red); background: rgb(163 60 50 / 0.1); }
      .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 34px; }
      .summary-card { padding: 16px; border-top: 4px solid var(--ink); background: var(--surface); box-shadow: var(--shadow); }
      .summary-card strong { display: block; font: 700 30px/1 "SFMono-Regular", Consolas, monospace; font-variant-numeric: tabular-nums; }
      .summary-card span { display: block; margin-top: 7px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .section-heading { display: flex; gap: 18px; align-items: baseline; justify-content: space-between; margin: 0 0 14px; }
      .section-heading h2 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
      .section-heading p { margin: 0; color: var(--muted); font-size: 13px; }
      .object-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .object-card {
        position: relative;
        min-width: 0;
        padding: 20px;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgb(255 255 255 / 0.9);
        box-shadow: var(--shadow);
      }
      .object-card::before { position: absolute; inset: 0 auto 0 0; width: 5px; background: var(--slate); content: ""; }
      .object-card[data-object-status="active"]::before { background: var(--teal); }
      .object-card[data-object-status="restoring"]::before { background: var(--blue); }
      .object-card[data-object-status="owner-expired"]::before,
      .object-card[data-object-status="owner-missing"]::before,
      .object-card[data-object-status="control-inconsistent"]::before { background: var(--red); }
      .object-header { display: flex; gap: 12px; align-items: start; justify-content: space-between; }
      .object-title { min-width: 0; }
      .object-title h3 { margin: 0; font-size: 19px; letter-spacing: -0.02em; }
      .object-title code { display: block; margin-top: 4px; overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .object-explanation { min-height: 44px; margin: 16px 0; color: var(--muted); text-wrap: pretty; }
      .object-facts { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border-top: 1px solid var(--line); }
      .fact { min-width: 0; padding: 12px 12px 12px 0; border-bottom: 1px solid var(--line); }
      .fact:nth-child(even) { padding-left: 12px; border-left: 1px solid var(--line); }
      .fact dt { margin: 0 0 5px; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }
      .fact dd { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; }
      .fact code { font-size: 12px; }
      .quiet { color: var(--muted); }
      .warning { color: var(--red); font-weight: 700; }
      .object-actions { display: flex; gap: 16px; min-height: 24px; margin-top: 15px; font-size: 13px; font-weight: 700; }
      details { margin-top: 36px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); }
      summary { min-height: 48px; padding: 14px 16px; cursor: pointer; font-weight: 800; }
      pre { margin: 0; padding: 0 16px 18px; overflow-x: auto; color: var(--muted); font-size: 12px; }
      @media (max-width: 800px) {
        .masthead { grid-template-columns: 1fr; align-items: start; }
        .snapshot-meta { text-align: left; }
        .summary-grid, .object-grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 560px) {
        .shell { width: min(100% - 20px, 1240px); padding-top: 20px; }
        .node-strip { grid-template-columns: 1fr; }
        .summary-grid, .object-grid { grid-template-columns: 1fr; }
        .object-facts { grid-template-columns: 1fr; }
        .fact:nth-child(even) { padding-left: 0; border-left: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .refresh-link { transition-duration: 0ms; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="masthead">
        <div>
          <p class="eyebrow">Graft fleet / control snapshot</p>
          <h1>Objects, owners, and durable wake state.</h1>
          <p class="masthead-copy">A read-only view of the shared control log. An object is active only when its ownership is ready and its owner's node lease has not expired.</p>
        </div>
        <div class="snapshot-meta">
          <a class="refresh-link" href="/">Refresh snapshot</a>
          <p class="mono">${escapeNodePageHtml(new Date(options.generatedAtMs).toISOString())}</p>
        </div>
      </header>

      <section class="node-strip" aria-label="Responding runtime node">
        <span class="status status-${escapeNodePageHtml(nodeState)}">${escapeNodePageHtml(nodeState)}</span>
        <code title="${escapeNodePageHtml(options.nodeId)}">${escapeNodePageHtml(options.nodeId)}</code>
        <span class="node-detail">This HTTP response · ${escapeNodePageHtml(nodeStateDetail)}</span>
      </section>

      <section class="summary-grid" aria-label="Fleet object summary">
        ${renderNodeSummaryCard(provisionedCount, "Provisioned")}
        ${renderNodeSummaryCard(activeCount, "Active")}
        ${renderNodeSummaryCard(scheduledAlarmCount, "Scheduled alarms")}
        ${renderNodeSummaryCard(attentionCount, "Needs attention")}
      </section>

      <section aria-labelledby="objects-heading">
        <div class="section-heading">
          <h2 id="objects-heading">Object directory</h2>
          <p>${objectViews.length} known identities · current node ${escapeNodePageHtml(formatNodePageIdentifier(options.nodeId))}</p>
        </div>
        <div class="object-grid">
          ${objectViews
            .map(({ object, status }) =>
              renderNodeObjectCard({
                generatedAtMs: options.generatedAtMs,
                currentNodeId: options.nodeId,
                applicationOrigin: options.applicationOrigin,
                object,
                status,
              }),
            )
            .join("\n")}
        </div>
      </section>

      <details>
        <summary>HTTP route reference</summary>
        <pre>Application listener: ${escapeNodePageHtml(options.applicationOrigin)}
GET  /_runtime/ready
GET  /objects/demo
POST /objects/demo/increments          {"deltas":[2,3],"label":"http-output-gate"}
POST /multi-object-increments          {"increments":[{"name":"demo","delta":1},{"name":"secondary","delta":7}]}
POST /objects/demo/compatibility-value {"value":"durable KV"}
POST /objects/demo/alarm               {"delayMs":0}
POST /objects/demo/background          {"note":"waitUntil completed"}
POST /objects/demo/callback
POST /objects/demo/capability           {"deltas":[4,1]}
POST /objects/demo/values
GET  /objects/demo/fetch/stream

Internal listener (this page):
GET  /health
GET  /debug/overview
GET  /control/demo
POST /tick</pre>
      </details>
    </main>
  </body>
</html>`;
}

function renderNodeSummaryCard(value: number, label: string): string {
  return `<div class="summary-card"><strong>${value}</strong><span>${escapeNodePageHtml(label)}</span></div>`;
}

function renderNodeObjectCard(options: {
  generatedAtMs: number;
  currentNodeId: string;
  applicationOrigin: string;
  object: ObjectControlOverview;
  status: ObjectStatus;
}): string {
  const { object, status } = options;
  const objectName = demoObjectName(object.objectId);
  const ownership = object.routingState?.ownership ?? null;
  const ownerIsLocal = status.ownerNodeId === options.currentNodeId;
  const ownerValue = status.ownerNodeId
    ? `${formatNodePageIdentifier(status.ownerNodeId)}${ownerIsLocal ? " · this node" : ""}`
    : "—";
  const leaseValue = status.ownerLeaseExpiresAtMs
    ? `${formatNodePageRelativeTime(status.ownerLeaseExpiresAtMs, options.generatedAtMs)} · ${new Date(status.ownerLeaseExpiresAtMs).toISOString()}`
    : "—";
  const alarm = describeNodePageAlarmWork(object, options.generatedAtMs);
  const remoteLogId = object.location?.remoteLogId ?? null;
  const actions = objectName
    ? `<a href="${escapeNodePageHtml(options.applicationOrigin)}/objects/${encodeURIComponent(objectName)}">Object state</a><a href="/control/${encodeURIComponent(objectName)}">Control JSON</a>`
    : `<span class="quiet">No application route for this identity</span>`;

  return `<article class="object-card" data-object-id="${escapeNodePageHtml(object.objectId)}" data-object-status="${escapeNodePageHtml(status.kind)}" data-owner-node-id="${escapeNodePageHtml(status.ownerNodeId ?? "")}">
    <div class="object-header">
      <div class="object-title">
        <h3>${escapeNodePageHtml(objectName ?? object.objectId)}</h3>
        <code title="${escapeNodePageHtml(object.objectId)}">${escapeNodePageHtml(object.objectId)}</code>
      </div>
      <span class="status status-${escapeNodePageHtml(status.kind)}">${escapeNodePageHtml(status.label)}</span>
    </div>
    <p class="object-explanation">${escapeNodePageHtml(status.explanation)}</p>
    <dl class="object-facts">
      ${renderNodePageFact("Owner node", ownerValue, status.ownerNodeId)}
      ${renderNodePageFact("Process generation", status.ownerProcessGeneration ? formatNodePageIdentifier(status.ownerProcessGeneration) : "—", status.ownerProcessGeneration)}
      ${renderNodePageFact("Owner lease", leaseValue, null, status.kind === "owner-expired")}
      ${renderNodePageFact("Epoch / lifecycle", ownership ? `${ownership.epoch} / ${ownership.state}` : "—", null)}
      ${renderNodePageFact("Alarm work", alarm.label, alarm.title, alarm.warning)}
      ${renderNodePageFact("Remote log", remoteLogId ? formatNodePageIdentifier(remoteLogId) : "—", remoteLogId)}
    </dl>
    <div class="object-actions">${actions}</div>
  </article>`;
}

function renderNodePageFact(
  label: string,
  value: string,
  title: string | null,
  warning = false,
): string {
  return `<div class="fact"><dt>${escapeNodePageHtml(label)}</dt><dd class="${warning ? "warning" : ""}"${title ? ` title="${escapeNodePageHtml(title)}"` : ""}><code>${escapeNodePageHtml(value)}</code></dd></div>`;
}

function describeNodePageAlarmWork(
  object: ObjectControlOverview,
  nowEpochMs: number,
): { label: string; title: string | null; warning: boolean } {
  const alarmWork = object.alarmWork;
  if (!alarmWork) {
    return { label: "None", title: null, warning: false };
  }
  if (alarmWork.kind === "reconcile") {
    return {
      label: "Repair pending",
      title: `reconciliation ${alarmWork.reconciliationId}`,
      warning: true,
    };
  }
  return {
    label: `Scheduled ${formatNodePageRelativeTime(alarmWork.dueAtMs, nowEpochMs)}`,
    title: `${new Date(alarmWork.dueAtMs).toISOString()} · installation ${alarmWork.installationId}`,
    warning: alarmWork.dueAtMs <= nowEpochMs,
  };
}

function demoObjectName(objectId: string): string | null {
  const prefix = "SHOWCASE:";
  if (!objectId.startsWith(prefix)) {
    return null;
  }
  const name = objectId.slice(prefix.length);
  return demoObjectNamePattern.test(name) ? name : null;
}

function formatNodePageIdentifier(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatNodePageRelativeTime(targetEpochMs: number, nowEpochMs: number): string {
  const differenceMs = targetEpochMs - nowEpochMs;
  const absoluteMs = Math.abs(differenceMs);
  if (absoluteMs < 1_000) {
    return "now";
  }
  const [value, unit] =
    absoluteMs < 60_000
      ? [Math.round(absoluteMs / 1_000), "s"]
      : absoluteMs < 3_600_000
        ? [Math.round(absoluteMs / 60_000), "m"]
        : [Math.round(absoluteMs / 3_600_000), "h"];
  return differenceMs > 0 ? `in ${value}${unit}` : `${value}${unit} ago`;
}

function escapeNodePageHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
