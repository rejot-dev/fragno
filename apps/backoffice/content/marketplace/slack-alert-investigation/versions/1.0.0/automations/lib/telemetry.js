/// <reference path="/static/codemode/workflow-authoring.d.ts" />

/** Slack escapes &, < and > in message text. @param {string} text */
function decodeSlack(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * The Cloudflare Worker an alert names, and the time window it reports.
 * @param {string} alert @param {string} receivedAt
 */
export function alertSubject(alert, receivedAt) {
  const text = decodeSlack(alert);
  const service =
    (/' detected in ([\w-]+)/.exec(text) || /New issue in ([\w-]+):/.exec(text) || [])[1] || null;
  const first = Date.parse((/First observed: (\S+?Z)/.exec(text) || [])[1] || "");
  const last = Date.parse((/Last observed: (\S+?Z)/.exec(text) || [])[1] || "");
  const received = Date.parse(receivedAt);
  // Without observed times, look back from delivery: alerting and paging add minutes of delay.
  const from = (Number.isNaN(first) ? received - 30 * 60000 : first) - 2 * 60000;
  const to = (Number.isNaN(last) ? received : last) + 2 * 60000;
  return { service, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * Read-only Workers telemetry for the alert's own service, reduced to the fields an investigation
 * needs. Request headers, IPs and TLS data stay in Cloudflare.
 * @param {{ service: string | null, from: string, to: string }} subject
 * @param {string | null} cloudflareAccountId null when the installation links no Cloudflare account
 */
export async function fetchServiceTelemetry(subject, cloudflareAccountId) {
  if (cloudflareAccountId === null) {
    return { service: subject.service, checked: false, reason: "No Cloudflare account is linked" };
  }
  if (!subject.service) {
    return { service: null, checked: false, reason: "The alert names no Cloudflare Worker" };
  }
  // Runs inside the Cloudflare MCP server, where `accountId` is the account passed as account_id.
  const code = `async () => {
    const name = ${JSON.stringify(subject.service)};
    const script = { exists: true, deployment: null };
    try {
      const d = await cloudflare.request({ method: "GET", path: "/accounts/" + accountId + "/workers/scripts/" + name + "/deployments" });
      const latest = (d.result.deployments || [])[0];
      script.deployment = latest ? { createdOn: latest.created_on, versions: latest.versions } : null;
    } catch (e) {
      if (!/\\b404\\b|not found|10007/i.test(String(e))) throw e;
      script.exists = false;
    }
    const r = await cloudflare.request({ method: "POST", path: "/accounts/" + accountId + "/workers/observability/telemetry/query", body: {
      queryId: "alert-service-telemetry", view: "events", limit: 100, dry: true,
      timeframe: { from: ${Date.parse(subject.from)}, to: ${Date.parse(subject.to)} },
      parameters: { filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: name }] } } });
    const events = r.result.events.events || [];
    const exceptions = new Map();
    const versions = new Set();
    const routes = new Map();
    for (const e of events) {
      const version = e.$workers && e.$workers.scriptVersion && e.$workers.scriptVersion.id;
      if (version) versions.add(version);
      const trigger = e.$metadata && e.$metadata.trigger;
      if (trigger && e.$workers && e.$workers.outcome === "exception") {
        const route = trigger.split("?")[0];
        routes.set(route, (routes.get(route) || 0) + 1);
      }
      const err = e.source && e.source.error;
      if (!err) continue;
      const key = err.name + "|" + err.message;
      const seen = exceptions.get(key) || { name: err.name, message: String(err.message).slice(0, 500),
        stack: String(err.stack || "").split("\\n").slice(0, 8).join("\\n"), count: 0,
        firstSeen: e.timestamp, lastSeen: e.timestamp };
      seen.count++;
      seen.firstSeen = Math.min(seen.firstSeen, e.timestamp);
      seen.lastSeen = Math.max(seen.lastSeen, e.timestamp);
      exceptions.set(key, seen);
    }
    return { script, eventsInWindow: events.length, eventLimit: 100, scriptVersions: [...versions],
      failingRoutes: Object.fromEntries(routes),
      exceptions: [...exceptions.values()].map((x) => ({ ...x,
        firstSeen: new Date(x.firstSeen).toISOString(), lastSeen: new Date(x.lastSeen).toISOString() })) };
  }`;
  const result = /** @type {any} */ (
    await integrations.execute({
      connectionId: "mcp#cloudflare",
      actionId: "execute",
      input: { account_id: cloudflareAccountId, code },
    })
  );
  const text = result?.content?.[0]?.text;
  if (!result || result.isError || typeof text !== "string") {
    throw new Error(
      "Cloudflare telemetry query failed: " + String(text || "no response").slice(0, 300),
    );
  }
  return {
    service: subject.service,
    checked: true,
    window: { from: subject.from, to: subject.to },
    ...JSON.parse(text),
  };
}
