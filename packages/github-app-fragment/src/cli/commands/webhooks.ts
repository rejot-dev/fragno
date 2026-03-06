import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { define } from "gunshi";

import { baseArgs, createClientFromContext, parseJsonValue } from "../utils/options.js";
import { printResult } from "../utils/output.js";
import { resolveWebhookSecret } from "../utils/config.js";

export const webhooksCommand = define({
  name: "webhooks",
  description: "Webhook utilities",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const resolvePayload = (ctx: { values: Record<string, unknown> }): Record<string, unknown> => {
  const payloadText = ctx.values["payload"] as string | undefined;
  const payloadFile = ctx.values["payload-file"] as string | undefined;

  if (payloadText && payloadFile) {
    throw new Error("Provide either --payload or --payload-file, not both.");
  }

  if (payloadFile) {
    const raw = readFileSync(payloadFile, "utf-8");
    const parsed = parseJsonValue("payload", raw);
    if (!isRecord(parsed)) {
      throw new Error("--payload-file must contain a JSON object");
    }
    return parsed;
  }

  if (payloadText) {
    const parsed = parseJsonValue("payload", payloadText);
    if (!isRecord(parsed)) {
      throw new Error("--payload must be a JSON object");
    }
    return parsed;
  }

  return {};
};

const ensureInstallationId = (
  payload: Record<string, unknown>,
  installationId: string | undefined,
) => {
  if (!installationId) {
    return;
  }

  if (payload["installation_id"]) {
    return;
  }

  const installation = payload["installation"];
  if (isRecord(installation)) {
    if ("id" in installation) {
      return;
    }
    installation["id"] = installationId;
    return;
  }

  payload["installation"] = { id: installationId };
};

export const webhooksSendCommand = define({
  name: "send",
  description: "Send a signed webhook payload",
  args: {
    ...baseArgs,
    event: {
      type: "string",
      description: "GitHub event name",
    },
    action: {
      type: "string",
      description: "Action name",
    },
    "installation-id": {
      type: "string",
      description: "Installation ID",
    },
    delivery: {
      type: "string",
      description: "Delivery id (defaults to random UUID)",
    },
    payload: {
      type: "string",
      description: "Payload JSON string",
    },
    "payload-file": {
      type: "string",
      description: "Path to JSON payload file",
    },
    "webhook-secret": {
      type: "string",
      description: "Webhook secret (env: GITHUB_APP_WEBHOOK_SECRET)",
    },
  },
  run: async (ctx) => {
    const event = ctx.values["event"] as string | undefined;
    if (!event) {
      throw new Error("Missing --event");
    }

    const payload = resolvePayload(ctx);
    const action = ctx.values["action"] as string | undefined;
    const installationId = ctx.values["installation-id"] as string | undefined;

    if (action && typeof payload["action"] !== "string") {
      payload["action"] = action;
    }

    ensureInstallationId(payload, installationId);

    if (!payload["installation_id"] && !payload["installation"]) {
      throw new Error(
        "Payload must include installation info. Provide --installation-id or include installation data in the payload.",
      );
    }

    const rawBody = JSON.stringify(payload);
    const secret = resolveWebhookSecret(ctx);
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

    const client = createClientFromContext(ctx);
    const delivery = (ctx.values["delivery"] as string | undefined) ?? randomUUID();

    const response = await client.request({
      method: "POST",
      path: "/webhooks",
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${signature}`,
      },
    });

    if (response.status === 204) {
      printResult(undefined);
      return;
    }

    const text = await response.text();
    if (!text) {
      printResult(undefined);
      return;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
    printResult(parsed ?? text);
  },
});

export const webhooksSubCommands: Map<string, ReturnType<typeof define>> = new Map();
webhooksSubCommands.set("send", webhooksSendCommand);
