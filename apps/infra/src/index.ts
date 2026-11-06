import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { RawNotificationPolicy } from "./raw-notification-policy.ts";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const alertEmails = config.requireObject<string[]>("alertEmails");
const pagerdutyRoutingKey = config.requireSecret("pagerdutyRoutingKey");

// The ReJot account's workers.dev subdomain, set under Workers & Pages.
const WORKERS_DEV_SUBDOMAIN = "rejot.workers.dev";

const relayWebhookSecret = new random.RandomPassword("pagerduty-relay-webhook-secret", {
  length: 32,
  special: false,
});

const pagerdutyRelay = new cloudflare.WorkersScript("pagerduty-relay", {
  accountId,
  scriptName: "leyway-pagerduty-relay",
  mainModule: "worker.js",
  content: stripTypeScriptTypes(
    readFileSync(new URL("pagerduty-relay-worker.ts", import.meta.url), "utf8"),
  ),
  compatibilityDate: "2026-11-01",
  bindings: [
    { name: "PAGERDUTY_ROUTING_KEY", type: "secret_text", text: pagerdutyRoutingKey },
    { name: "WEBHOOK_SECRET", type: "secret_text", text: relayWebhookSecret.result },
  ],
  observability: { enabled: true },
});

const pagerdutyRelayRoute = new cloudflare.WorkersScriptSubdomain("pagerduty-relay", {
  accountId,
  scriptName: pagerdutyRelay.scriptName,
  enabled: true,
  previewsEnabled: false,
});

// Cloudflare sends a test message when it saves the destination, so the Worker must be reachable
// first.
const pagerdutyWebhook = new cloudflare.NotificationPolicyWebhooks(
  "pagerduty-relay",
  {
    accountId,
    name: "Leyway PagerDuty relay",
    url: pulumi.interpolate`https://${pagerdutyRelay.scriptName}.${WORKERS_DEV_SUBDOMAIN}`,
    secret: relayWebhookSecret.result,
  },
  { dependsOn: [pagerdutyRelayRoute] },
);

// Email stays alongside PagerDuty, so alerts still reach us when the relay is broken.
const mechanisms = {
  emails: alertEmails.map((id) => ({ id })),
  webhooks: [{ id: pagerdutyWebhook.id }],
};

// Cloudflare status components Leyway runs on, from
// https://www.cloudflarestatus.com/api/v2/components.json.
const LEYWAY_STATUS_COMPONENTS = {
  workers: "57srcl8zcn7c",
  durableObjects: "bty1yz6dhh0v",
  r2: "hb7g5sq2zz0h",
  workersAi: "zvm7mqn92xzc",
};

// Workers Issues only watches Workers that set `observability.issues.enabled` in their Wrangler
// config, and this alert type has no filters, so that setting is what limits it to Leyway.
new RawNotificationPolicy("worker-issue", {
  accountId,
  name: "Leyway: new Worker issue",
  description:
    "A Leyway Worker or Durable Object fails in a way Workers Issues has not seen before.",
  alertType: "workers_observability_real_time_issue",
  emails: alertEmails,
  webhookIds: pulumi.all([pagerdutyWebhook.id]),
});

new cloudflare.NotificationPolicy("cloudflare-incident", {
  accountId,
  name: "Leyway: Cloudflare incident",
  description: "A major or critical Cloudflare incident affects a product Leyway runs on.",
  alertType: "incident_alert",
  enabled: true,
  filters: {
    affectedComponents: Object.values(LEYWAY_STATUS_COMPONENTS),
    incidentImpacts: ["INCIDENT_IMPACT_MAJOR", "INCIDENT_IMPACT_CRITICAL"],
  },
  mechanisms,
});

// Only fired on demand through Cloudflare's "Test a Notification policy" endpoint, to check that
// alerts reach us. We run no Logpush jobs, so its alert type never fires on its own.
const testAlert = new cloudflare.NotificationPolicy("test-alert", {
  accountId,
  name: "Leyway: test alert",
  description: "Fired by hand to check that Leyway's alerts are delivered.",
  alertType: "failing_logpush_job_disabled_alert",
  enabled: true,
  mechanisms,
});

export const testAlertPolicyId = testAlert.id;
