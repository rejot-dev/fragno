/** Renders the local fleet switchboard; live state and actions are supplied by the fleet app API. */
export function renderFleetPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Runtime fleet switchboard</title>
    <style>
      :root {
        color-scheme: light;
        --canvas: #e8eff1;
        --paper: #f7faf9;
        --paper-strong: #ffffff;
        --ink: #102b38;
        --muted: #647780;
        --line: #bdcdd1;
        --cyan: #087d86;
        --cyan-soft: #d8eeed;
        --blue: #315e9b;
        --amber: #b36812;
        --red: #b23e3c;
        --shadow: 0 17px 42px rgb(27 54 66 / 0.09), 0 2px 5px rgb(27 54 66 / 0.08);
      }
      * { box-sizing: border-box; }
      html { -webkit-font-smoothing: antialiased; }
      body {
        margin: 0;
        color: var(--ink);
        background:
          linear-gradient(rgb(255 255 255 / 0.42) 1px, transparent 1px),
          linear-gradient(90deg, rgb(255 255 255 / 0.42) 1px, transparent 1px),
          var(--canvas);
        background-size: 22px 22px;
        font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button, input, select, textarea { font: inherit; }
      button, select { min-height: 40px; }
      button {
        border: 1px solid var(--ink);
        border-radius: 6px;
        color: var(--ink);
        background: var(--paper-strong);
        box-shadow: 2px 2px 0 var(--ink);
        cursor: pointer;
        font-weight: 750;
        transition-property: transform, box-shadow, background-color, color;
        transition-duration: 120ms;
      }
      button:hover { background: var(--cyan-soft); }
      button:active { transform: translate(1px, 1px) scale(0.96); box-shadow: 1px 1px 0 var(--ink); }
      button:disabled { cursor: wait; opacity: 0.55; }
      button.danger { border-color: var(--red); color: var(--red); box-shadow: 2px 2px 0 var(--red); }
      button.quiet { border-color: var(--line); color: var(--muted); box-shadow: none; }
      button.primary { color: white; background: var(--ink); }
      button.primary:hover { background: var(--cyan); }
      input, select, textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 5px;
        color: var(--ink);
        background: white;
      }
      input, select { min-height: 40px; padding: 8px 10px; }
      textarea { min-height: 112px; padding: 10px; resize: vertical; }
      button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
        outline: 3px solid rgb(8 125 134 / 0.28);
        outline-offset: 2px;
      }
      code, pre, .mono {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-variant-numeric: tabular-nums;
      }
      .shell { width: min(1500px, calc(100% - 32px)); margin: 0 auto; padding: 30px 0 70px; }
      .masthead {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 28px;
        align-items: end;
        padding: 22px 0 26px;
        border-bottom: 2px solid var(--ink);
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--cyan);
        font: 800 12px/1.2 "SFMono-Regular", Consolas, monospace;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: clamp(34px, 5vw, 64px); line-height: 0.96; letter-spacing: -0.05em; text-wrap: balance; }
      .masthead p:last-child { max-width: 780px; margin: 16px 0 0; color: var(--muted); font-size: 16px; text-wrap: pretty; }
      .masthead-actions { display: grid; gap: 8px; justify-items: end; }
      .updated { color: var(--muted); font-size: 12px; }
      .summary {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin: 22px 0 34px;
      }
      .metric { padding: 15px 16px; border-top: 4px solid var(--ink); background: var(--paper); box-shadow: var(--shadow); }
      .metric strong { display: block; font: 800 29px/1 "SFMono-Regular", Consolas, monospace; font-variant-numeric: tabular-nums; }
      .metric span { display: block; margin-top: 7px; color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }
      .section { margin-top: 36px; }
      .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 18px; margin-bottom: 13px; }
      .section-heading h2 { margin: 0; font-size: 21px; letter-spacing: -0.025em; }
      .section-heading p { margin: 0; color: var(--muted); font-size: 13px; }
      .node-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 15px; }
      .node-card {
        position: relative;
        min-width: 0;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgb(255 255 255 / 0.93);
        box-shadow: var(--shadow);
      }
      .node-card::before { position: absolute; inset: 0 0 auto; height: 5px; background: var(--muted); content: ""; }
      .node-card[data-node-state="serving"]::before { background: var(--cyan); }
      .node-card[data-node-state="crashed"]::before { background: var(--red); }
      .node-card[data-node-state="starting"], .node-card[data-node-state="stopping"] { opacity: 0.78; }
      .node-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 20px 20px 15px; }
      .node-title h3 { margin: 0; font-size: 21px; letter-spacing: -0.03em; }
      .node-title code { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        width: fit-content;
        padding: 5px 9px;
        border-radius: 999px;
        color: var(--muted);
        background: rgb(100 119 128 / 0.11);
        font: 800 10px/1.2 "SFMono-Regular", Consolas, monospace;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .status::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; content: ""; }
      .status-serving, .status-active { color: var(--cyan); background: rgb(8 125 134 / 0.11); }
      .status-restoring, .status-starting, .status-stopping { color: var(--blue); background: rgb(49 94 155 / 0.11); }
      .status-crashed, .status-owner-expired, .status-owner-missing, .status-control-inconsistent { color: var(--red); background: rgb(178 62 60 / 0.11); }
      .node-facts { display: grid; grid-template-columns: 1fr 1fr; margin: 0 20px 17px; border-top: 1px solid var(--line); }
      .fact { min-width: 0; padding: 10px 10px 10px 0; border-bottom: 1px solid var(--line); }
      .fact:nth-child(even) { padding-left: 10px; border-left: 1px solid var(--line); }
      .fact dt { margin-bottom: 4px; color: var(--muted); font-size: 9px; font-weight: 850; letter-spacing: 0.1em; text-transform: uppercase; }
      .fact dd { margin: 0; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .owned-strip { min-height: 58px; padding: 12px 20px; border-top: 1px solid var(--line); background: rgb(216 238 237 / 0.34); }
      .owned-strip strong { display: block; margin-bottom: 7px; color: var(--muted); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; }
      .object-chip { display: inline-flex; margin: 0 5px 5px 0; padding: 4px 7px; border-radius: 4px; color: var(--cyan); background: white; box-shadow: 0 0 0 1px rgb(8 125 134 / 0.24); font: 700 11px/1.3 "SFMono-Regular", Consolas, monospace; }
      .node-request { display: grid; grid-template-columns: minmax(0, 1fr) repeat(4, auto); gap: 7px; padding: 16px 20px; border-top: 1px solid var(--line); }
      .node-request button { padding: 0 10px; }
      .node-lifecycle { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 20px 20px; }
      .node-lifecycle button { padding: 0 11px; }
      .offline-copy { margin: 0; padding: 0 20px 17px; color: var(--muted); text-wrap: pretty; }
      .matrix-frame { overflow-x: auto; border: 1px solid var(--line); border-radius: 9px; background: rgb(255 255 255 / 0.92); box-shadow: var(--shadow); }
      table { width: 100%; min-width: 800px; border-collapse: collapse; }
      th, td { padding: 13px 14px; border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); text-align: left; vertical-align: middle; }
      th:last-child, td:last-child { border-right: 0; }
      tr:last-child td { border-bottom: 0; }
      thead th { color: var(--muted); background: var(--paper); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
      tbody th { min-width: 210px; }
      .object-name { display: block; font-size: 14px; }
      .object-meta { display: block; margin-top: 4px; color: var(--muted); font: 11px/1.35 "SFMono-Regular", Consolas, monospace; font-variant-numeric: tabular-nums; }
      .route-cell { min-width: 130px; color: var(--muted); text-align: center; }
      .route-owner { color: var(--cyan); background: rgb(216 238 237 / 0.46); font-weight: 800; }
      .route-owner::before { display: inline-block; width: 8px; height: 8px; margin-right: 7px; border-radius: 50%; background: currentColor; content: ""; }
      .disagreement { color: var(--red); font-weight: 800; }
      .control-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr); gap: 15px; }
      .panel { padding: 20px; border: 1px solid var(--line); border-radius: 9px; background: rgb(255 255 255 / 0.92); box-shadow: var(--shadow); }
      .panel h3 { margin: 0 0 15px; font-size: 17px; }
      .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
      .field { display: grid; gap: 5px; }
      .field label { color: var(--muted); font-size: 10px; font-weight: 850; letter-spacing: 0.08em; text-transform: uppercase; }
      .field-wide { grid-column: 1 / -1; }
      .form-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
      .form-actions button { padding: 0 16px; }
      .activity-log { max-height: 360px; margin: 0; padding: 0; overflow: auto; list-style: none; }
      .activity-log li { padding: 11px 0; border-top: 1px solid var(--line); }
      .activity-log li:first-child { border-top: 0; padding-top: 0; }
      .activity-log strong { display: block; font-size: 12px; }
      .activity-log pre { margin: 6px 0 0; overflow-x: auto; color: var(--muted); font-size: 11px; white-space: pre-wrap; }
      .empty { color: var(--muted); }
      .error-banner { display: none; margin: 20px 0 0; padding: 12px 14px; border-left: 4px solid var(--red); color: var(--red); background: #fff1ef; font-weight: 750; }
      .error-banner[data-visible="true"] { display: block; }
      @media (max-width: 900px) {
        .masthead { grid-template-columns: 1fr; }
        .masthead-actions { justify-items: start; }
        .summary { grid-template-columns: 1fr 1fr; }
        .control-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 620px) {
        .shell { width: min(100% - 20px, 1500px); padding-top: 16px; }
        .summary { grid-template-columns: 1fr 1fr; }
        .node-request { grid-template-columns: 1fr 1fr; }
        .node-request input { grid-column: 1 / -1; }
        .field-grid { grid-template-columns: 1fr; }
        .field-wide { grid-column: auto; }
      }
      @media (prefers-reduced-motion: reduce) {
        button { transition-duration: 0ms; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="masthead">
        <div>
          <p class="eyebrow">Local runtime fleet / live switchboard</p>
          <h1>See ingress and ownership diverge.</h1>
          <p>The fleet app supervises independent runtime nodes. Send work through any ingress, then watch the durable directory route each object to its current owner.</p>
        </div>
        <div class="masthead-actions">
          <button id="refresh" type="button">Refresh fleet</button>
          <span class="updated mono" id="updated">Waiting for first observation</span>
        </div>
      </header>

      <div class="error-banner" id="error-banner" data-visible="false" role="alert"></div>

      <section class="summary" aria-label="Fleet summary">
        <div class="metric"><strong id="node-count">—</strong><span>Serving nodes</span></div>
        <div class="metric"><strong id="object-count">—</strong><span>Provisioned objects</span></div>
        <div class="metric"><strong id="active-count">—</strong><span>Active objects</span></div>
        <div class="metric"><strong id="disagreement-count">—</strong><span>View disagreements</span></div>
      </section>

      <section class="section" aria-labelledby="nodes-heading">
        <div class="section-heading">
          <h2 id="nodes-heading">Node ingress</h2>
          <p>Every card targets one exact child process.</p>
        </div>
        <div class="node-grid" id="nodes"></div>
      </section>

      <section class="section" aria-labelledby="placement-heading">
        <div class="section-heading">
          <h2 id="placement-heading">Object placement board</h2>
          <p>Rows are durable identities; columns are current process owners.</p>
        </div>
        <div class="matrix-frame" id="placement"></div>
      </section>

      <section class="section" aria-labelledby="requests-heading">
        <div class="section-heading">
          <h2 id="requests-heading">Cross-node controls</h2>
          <p>Requests enter the selected node even when another node owns the object.</p>
        </div>
        <div class="control-grid">
          <div class="panel">
            <h3>Multi-object output gate</h3>
            <form id="multi-form">
              <div class="field-grid">
                <div class="field">
                  <label for="multi-node">Ingress node</label>
                  <select id="multi-node" name="node"></select>
                </div>
                <div class="field">
                  <label for="multi-name">Additional object</label>
                  <input id="multi-name" name="name" value="customer-42" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" required>
                </div>
                <div class="field">
                  <label for="multi-demo-delta">demo delta</label>
                  <input id="multi-demo-delta" name="demoDelta" type="number" step="1" value="1" required>
                </div>
                <div class="field">
                  <label for="multi-secondary-delta">secondary delta</label>
                  <input id="multi-secondary-delta" name="secondaryDelta" type="number" step="1" value="7" required>
                </div>
                <div class="field field-wide">
                  <label for="multi-custom-delta">Additional object delta</label>
                  <input id="multi-custom-delta" name="customDelta" type="number" step="1" value="11" required>
                </div>
              </div>
              <div class="form-actions"><button class="primary" type="submit">Send multi-object request</button></div>
            </form>

            <h3 style="margin-top: 30px">Request console</h3>
            <form id="request-form">
              <div class="field-grid">
                <div class="field">
                  <label for="request-node">Ingress node</label>
                  <select id="request-node" name="node"></select>
                </div>
                <div class="field">
                  <label for="request-method">Method</label>
                  <select id="request-method" name="method"><option>GET</option><option>POST</option></select>
                </div>
                <div class="field field-wide">
                  <label for="request-path">Relative path</label>
                  <input id="request-path" name="path" value="/objects/demo" required>
                </div>
                <div class="field">
                  <label for="request-ingress">Listener</label>
                  <select id="request-ingress" name="ingress"><option value="application">Application</option><option value="internal">Internal / administration</option></select>
                </div>
                <div class="field field-wide">
                  <label for="request-body">JSON body; leave empty for no body</label>
                  <textarea id="request-body" name="body" spellcheck="false">{"deltas":[1],"label":"fleet-console"}</textarea>
                </div>
              </div>
              <div class="form-actions"><button class="primary" type="submit">Send exact-node request</button></div>
            </form>
          </div>

          <aside class="panel" aria-labelledby="activity-heading">
            <h3 id="activity-heading">Request activity</h3>
            <ol class="activity-log" id="activity"><li class="empty">No requests sent from this page yet.</li></ol>
          </aside>
        </div>
      </section>
    </main>

    <script>
      const ui = {
        snapshot: null,
        activity: [],
        busy: false,
      };

      const objectNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function shortIdentifier(value) {
        if (!value) return '—';
        return value.length <= 18 ? value : value.slice(0, 7) + '…' + value.slice(-5);
      }

      function nodeIdentity(node) {
        if (node.state === 'serving' || node.state === 'stopping') return node.identity;
        return node.lastIdentity;
      }

      function nodeOptions(selected) {
        if (!ui.snapshot) return '';
        return ui.snapshot.nodes.map(function (node) {
          const disabled = node.state !== 'serving' ? ' disabled' : '';
          const isSelected = node.slot === selected ? ' selected' : '';
          return '<option value="' + escapeHtml(node.slot) + '"' + disabled + isSelected + '>' + escapeHtml(node.slot + ' · ' + node.state) + '</option>';
        }).join('');
      }

      function renderNodeCard(node) {
        const identity = nodeIdentity(node);
        const observation = node.state === 'serving' ? node.observation : null;
        const authority = observation && observation.kind === 'available' ? observation.overview.nodeAuthority : null;
        const lease = authority && authority.state === 'serving' ? new Date(authority.window.leaseExpiresAtEpochMs).toLocaleTimeString() : '—';
        const latency = observation ? (observation.kind === 'available' ? observation.latencyMs + ' ms' : 'unavailable') : '—';
        const owned = node.ownedObjectIds.length === 0
          ? '<span class="empty">No active objects</span>'
          : node.ownedObjectIds.map(function (objectId) { return '<span class="object-chip">' + escapeHtml(objectId.replace('SHOWCASE:', '')) + '</span>'; }).join('');
        const requestForm = node.state === 'serving'
          ? '<form class="node-request" data-node-request-form="' + escapeHtml(node.slot) + '">' +
              '<input name="name" value="demo" aria-label="Object name for ' + escapeHtml(node.slot) + '" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" required>' +
              '<button name="operation" value="read" type="submit">Read</button>' +
              '<button name="operation" value="increment" type="submit">+1</button>' +
              '<button name="operation" value="control" type="submit">Control</button>' +
              '<button name="operation" value="alarm" type="submit">Alarm</button>' +
            '</form>'
          : '<p class="offline-copy">This ingress is offline. Restart it to publish a fresh node identity.</p>';
        const servingActions = node.state === 'serving'
          ? '<button class="quiet" data-lifecycle="stop" data-node="' + escapeHtml(node.slot) + '">Graceful stop</button>' +
            '<button class="danger" data-lifecycle="crash" data-node="' + escapeHtml(node.slot) + '">Hard crash</button>' +
            '<button class="quiet" data-lifecycle="delete-cache-and-restart" data-node="' + escapeHtml(node.slot) + '">Delete cache + restart</button>'
          : '<button data-lifecycle="restart" data-node="' + escapeHtml(node.slot) + '">Restart node</button>' +
            '<button class="quiet" data-lifecycle="delete-cache-and-restart" data-node="' + escapeHtml(node.slot) + '">Delete cache + restart</button>';
        const reason = node.state === 'stopped' || node.state === 'crashed' ? node.reason : 'managed child process';
        return '<article class="node-card" data-node-slot="' + escapeHtml(node.slot) + '" data-node-state="' + escapeHtml(node.state) + '">' +
          '<div class="node-head"><div class="node-title"><h3>' + escapeHtml(node.slot) + '</h3><code title="' + escapeHtml(identity ? identity.nodeId : '') + '">' + escapeHtml(shortIdentifier(identity ? identity.nodeId : null)) + '</code></div><span class="status status-' + escapeHtml(node.state) + '">' + escapeHtml(node.state) + '</span></div>' +
          '<dl class="node-facts">' +
            '<div class="fact"><dt>PID</dt><dd class="mono">' + escapeHtml(identity ? identity.processId : '—') + '</dd></div>' +
            '<div class="fact"><dt>Observation</dt><dd class="mono">' + escapeHtml(latency) + '</dd></div>' +
            '<div class="fact"><dt>Generation</dt><dd class="mono" title="' + escapeHtml(identity ? identity.processGeneration : '') + '">' + escapeHtml(shortIdentifier(identity ? identity.processGeneration : null)) + '</dd></div>' +
            '<div class="fact"><dt>Lease</dt><dd class="mono">' + escapeHtml(lease) + '</dd></div>' +
            '<div class="fact"><dt>Application</dt><dd class="mono" title="' + escapeHtml(identity ? identity.applicationOrigin : reason) + '">' + escapeHtml(identity ? identity.applicationOrigin : reason) + '</dd></div>' +
            '<div class="fact"><dt>Internal</dt><dd class="mono" title="' + escapeHtml(identity ? identity.internalOrigin : reason) + '">' + escapeHtml(identity ? identity.internalOrigin : reason) + '</dd></div>' +
            '<div class="fact"><dt>Cache</dt><dd class="mono" title="' + escapeHtml(node.cacheDirectory) + '">' + escapeHtml(shortIdentifier(node.cacheDirectory)) + '</dd></div>' +
          '</dl>' +
          '<div class="owned-strip"><strong>Objects executing here</strong>' + owned + '</div>' +
          requestForm +
          '<div class="node-lifecycle">' + servingActions + '</div>' +
        '</article>';
      }

      function renderPlacement(snapshot) {
        const nodeHeaders = snapshot.nodes.map(function (node) { return '<th scope="col">' + escapeHtml(node.slot) + '</th>'; }).join('');
        const rows = snapshot.objects.map(function (object) {
          const ownerLabel = object.owner.kind === 'managed' ? object.owner.slot : object.owner.kind === 'external' ? 'external ' + shortIdentifier(object.owner.nodeId) : 'none';
          const alarm = object.alarm.kind === 'scheduled' && object.alarm.dueAtMs ? ' · alarm ' + new Date(object.alarm.dueAtMs).toLocaleTimeString() : object.alarm.kind === 'reconcile' ? ' · alarm repair' : '';
          const agreement = object.observationsAgree ? '' : '<span class="disagreement"> · views disagree</span>';
          const cells = snapshot.nodes.map(function (node) {
            const owns = object.owner.kind === 'managed' && object.owner.slot === node.slot;
            return '<td class="route-cell' + (owns ? ' route-owner' : '') + '">' + (owns ? escapeHtml(object.status.label) : '—') + '</td>';
          }).join('');
          return '<tr data-object-id="' + escapeHtml(object.objectId) + '" data-object-status="' + escapeHtml(object.status.kind) + '" data-owner-slot="' + escapeHtml(object.owner.kind === 'managed' ? object.owner.slot : '') + '">' +
            '<th scope="row"><span class="object-name">' + escapeHtml(object.name) + '</span><span class="object-meta">' + escapeHtml(object.status.label + ' · owner ' + ownerLabel + ' · epoch ' + (object.ownershipEpoch || '—') + alarm) + agreement + '</span></th>' + cells +
          '</tr>';
        }).join('');
        return '<table><thead><tr><th scope="col">Durable object</th>' + nodeHeaders + '</tr></thead><tbody>' + (rows || '<tr><td colspan="99" class="empty">No node observations are available.</td></tr>') + '</tbody></table>';
      }

      function renderFleet(snapshot) {
        ui.snapshot = snapshot;
        const servingNodes = snapshot.nodes.filter(function (node) { return node.state === 'serving'; }).length;
        const provisionedObjects = snapshot.objects.filter(function (object) { return object.status.kind !== 'not-provisioned'; }).length;
        const activeObjects = snapshot.objects.filter(function (object) { return object.status.kind === 'active'; }).length;
        const disagreements = snapshot.objects.filter(function (object) { return !object.observationsAgree; }).length;
        document.getElementById('node-count').textContent = String(servingNodes) + ' / ' + String(snapshot.nodes.length);
        document.getElementById('object-count').textContent = String(provisionedObjects);
        document.getElementById('active-count').textContent = String(activeObjects);
        document.getElementById('disagreement-count').textContent = String(disagreements);
        document.getElementById('nodes').innerHTML = snapshot.nodes.map(renderNodeCard).join('');
        document.getElementById('placement').innerHTML = renderPlacement(snapshot);
        const currentMultiNode = document.getElementById('multi-node').value;
        const currentRequestNode = document.getElementById('request-node').value;
        document.getElementById('multi-node').innerHTML = nodeOptions(currentMultiNode);
        document.getElementById('request-node').innerHTML = nodeOptions(currentRequestNode);
        document.getElementById('updated').textContent = 'Observed ' + new Date(snapshot.generatedAtMs).toLocaleString();
        bindDynamicControls();
      }

      function renderActivity() {
        const activity = document.getElementById('activity');
        if (ui.activity.length === 0) {
          activity.innerHTML = '<li class="empty">No requests sent from this page yet.</li>';
          return;
        }
        activity.innerHTML = ui.activity.map(function (entry) {
          return '<li><strong>' + escapeHtml(entry.title) + '</strong><pre>' + escapeHtml(entry.detail) + '</pre></li>';
        }).join('');
      }

      function recordActivity(title, value) {
        const detail = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        ui.activity.unshift({ title: new Date().toLocaleTimeString() + ' · ' + title, detail: detail });
        ui.activity = ui.activity.slice(0, 20);
        renderActivity();
      }

      async function refreshFleet() {
        try {
          const response = await fetch('/api/fleet', { cache: 'no-store' });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || 'Fleet observation failed');
          document.getElementById('error-banner').dataset.visible = 'false';
          renderFleet(value);
        } catch (error) {
          const banner = document.getElementById('error-banner');
          banner.textContent = error instanceof Error ? error.message : String(error);
          banner.dataset.visible = 'true';
        }
      }

      async function forwardNodeRequest(node, method, path, body, ingress = 'application') {
        setBusy(true);
        try {
          const response = await fetch('/api/nodes/' + encodeURIComponent(node) + '/requests', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ingress: ingress, method: method, path: path, body: body }),
          });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || 'Node request failed');
          recordActivity(node + ' · ' + ingress + ' → ' + method + ' ' + path, value);
        } catch (error) {
          recordActivity(node + ' request failed', error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
          await refreshFleet();
        }
      }

      async function changeNodeLifecycle(node, action) {
        setBusy(true);
        try {
          const response = await fetch('/api/nodes/' + encodeURIComponent(node) + '/lifecycle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action }),
          });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || 'Node lifecycle action failed');
          recordActivity(node + ' · ' + action, value);
        } catch (error) {
          recordActivity(node + ' lifecycle failed', error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
          await refreshFleet();
        }
      }

      function setBusy(busy) {
        ui.busy = busy;
        document.querySelectorAll('button').forEach(function (button) { button.disabled = busy; });
      }

      function bindDynamicControls() {
        document.querySelectorAll('[data-node-request-form]').forEach(function (form) {
          form.addEventListener('submit', function (event) {
            event.preventDefault();
            const node = form.dataset.nodeRequestForm;
            const name = new FormData(form).get('name');
            const operation = event.submitter ? event.submitter.value : 'read';
            if (!node || typeof name !== 'string' || !objectNamePattern.test(name)) return;
            if (operation === 'read') void forwardNodeRequest(node, 'GET', '/objects/' + encodeURIComponent(name), null);
            if (operation === 'increment') void forwardNodeRequest(node, 'POST', '/objects/' + encodeURIComponent(name) + '/increments', { deltas: [1], label: 'fleet-node-card' });
            if (operation === 'control') void forwardNodeRequest(node, 'GET', '/control/' + encodeURIComponent(name), null, 'internal');
            if (operation === 'alarm') void forwardNodeRequest(node, 'POST', '/objects/' + encodeURIComponent(name) + '/alarm', { delayMs: 0 });
          });
        });
        document.querySelectorAll('[data-lifecycle]').forEach(function (button) {
          button.addEventListener('click', function () {
            const node = button.dataset.node;
            const action = button.dataset.lifecycle;
            if (node && action) void changeNodeLifecycle(node, action);
          });
        });
      }

      document.getElementById('refresh').addEventListener('click', function () { void refreshFleet(); });
      document.getElementById('multi-form').addEventListener('submit', function (event) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const node = data.get('node');
        const name = data.get('name');
        if (typeof node !== 'string' || typeof name !== 'string' || !objectNamePattern.test(name)) return;
        const increments = [
          { name: 'demo', delta: Number(data.get('demoDelta')) },
          { name: 'secondary', delta: Number(data.get('secondaryDelta')) },
        ];
        if (name !== 'demo' && name !== 'secondary') increments.push({ name: name, delta: Number(data.get('customDelta')) });
        void forwardNodeRequest(node, 'POST', '/multi-object-increments', { increments: increments });
      });
      document.getElementById('request-form').addEventListener('submit', function (event) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const node = data.get('node');
        const method = data.get('method');
        const path = data.get('path');
        const bodySource = data.get('body');
        if (typeof node !== 'string' || typeof method !== 'string' || typeof path !== 'string' || typeof bodySource !== 'string') return;
        try {
          const body = bodySource.trim().length === 0 ? null : JSON.parse(bodySource);
          void forwardNodeRequest(node, method, path, body, data.get('ingress'));
        } catch (error) {
          recordActivity('Request body is not valid JSON', error instanceof Error ? error.message : String(error));
        }
      });

      void refreshFleet();
      setInterval(function () { if (!document.hidden && !ui.busy) void refreshFleet(); }, 1500);
    </script>
  </body>
</html>`;
}
