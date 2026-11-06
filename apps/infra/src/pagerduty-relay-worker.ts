// Cloudflare only sends alerts to PagerDuty itself when a zone is on the Business plan, so our alert
// policies send a generic webhook to this Worker, which turns it into a PagerDuty Events API v2
// event. `index.ts` uploads this file with its types stripped, so it cannot import anything.

interface Env {
  PAGERDUTY_ROUTING_KEY: string;
  WEBHOOK_SECRET: string;
}

// The generic webhook body, see
// https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/. Only `text` is
// always there: the test message Cloudflare sends when the destination is saved has nothing else.
interface CloudflareAlert {
  text: string;
  name?: string;
  alert_event?: string;
  alert_correlation_id?: string;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

// Compares digests of equal length, so the time it takes says nothing about the secret.
async function isFromCloudflare(request: Request, secret: string): Promise<boolean> {
  const [given, expected] = await Promise.all([
    sha256(request.headers.get("cf-webhook-auth") ?? ""),
    sha256(secret),
  ]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= given[i] ^ expected[i];
  }
  return difference === 0;
}

function toPagerDutyEvent(alert: CloudflareAlert, routingKey: string) {
  // PagerDuty finds the incident to resolve by its dedup key, so an alert without one can only
  // trigger.
  const resolves =
    alert.alert_event === "ALERT_STATE_EVENT_END" && alert.alert_correlation_id !== undefined;
  return {
    routing_key: routingKey,
    event_action: resolves ? "resolve" : "trigger",
    dedup_key: alert.alert_correlation_id,
    payload: {
      summary: (alert.name ? `${alert.name}: ${alert.text}` : alert.text).slice(0, 1024),
      source: "cloudflare",
      severity: "critical",
      custom_details: alert,
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    if (!(await isFromCloudflare(request, env.WEBHOOK_SECRET))) {
      return new Response(null, { status: 401 });
    }
    const alert = (await request.json()) as CloudflareAlert;
    const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toPagerDutyEvent(alert, env.PAGERDUTY_ROUTING_KEY)),
    });
    // Passes PagerDuty's answer on, so Cloudflare records a delivery PagerDuty rejected as failed.
    return new Response(await response.text(), { status: response.status });
  },
};
