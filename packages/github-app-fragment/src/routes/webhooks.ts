import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { githubAppFragmentDefinition } from "../github/definition";
import type { WebhookProcessingPayload } from "../github/webhook-processing";
import { githubAppSchema } from "../schema";
import { isRecord, toDebugSignature, toStringValue } from "./shared";

export const githubAppWebhookRoutesFactory = defineRoutes(githubAppFragmentDefinition).create(
  ({ config, defineRoute, deps }) => {
    const api = deps.githubApiClient;

    return [
      defineRoute({
        method: "POST",
        path: "/webhooks",
        errorCodes: [
          "WEBHOOK_SIGNATURE_INVALID",
          "WEBHOOK_DELIVERY_MISSING",
          "WEBHOOK_PAYLOAD_INVALID",
        ],
        handler: async function (ctx, { empty, error }) {
          const rawBody = ctx.rawBody;
          const logWebhook =
            config.webhookDebug === true
              ? (message: string, details?: Record<string, unknown>) => {
                  if (details) {
                    console.log("[github-app-fragment webhook]", message, details);
                  } else {
                    console.log("[github-app-fragment webhook]", message);
                  }
                }
              : undefined;

          logWebhook?.("received", {
            hasRawBody: Boolean(rawBody),
            rawBodyBytes: rawBody ? Buffer.byteLength(rawBody, "utf8") : 0,
            signature: toDebugSignature(ctx.headers.get("x-hub-signature-256")),
            deliveryId: ctx.headers.get("x-github-delivery") ?? null,
            event: ctx.headers.get("x-github-event") ?? null,
            contentType: ctx.headers.get("content-type") ?? null,
          });

          if (!rawBody) {
            logWebhook?.("rejected: missing payload");
            return error(
              { message: "Missing webhook payload.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          const signatureHeader = ctx.headers.get("x-hub-signature-256");
          const signatureOk = await api.verifyWebhookSignature({
            payload: rawBody,
            signatureHeader,
          });
          logWebhook?.("signature check", { ok: signatureOk });
          if (!signatureOk) {
            logWebhook?.("rejected: invalid signature");
            return error(
              { message: "Invalid webhook signature.", code: "WEBHOOK_SIGNATURE_INVALID" },
              { status: 401 },
            );
          }

          const deliveryId = ctx.headers.get("x-github-delivery") ?? "";
          if (!deliveryId) {
            logWebhook?.("rejected: missing delivery id");
            return error(
              { message: "Missing delivery id.", code: "WEBHOOK_DELIVERY_MISSING" },
              { status: 400 },
            );
          }

          const event = ctx.headers.get("x-github-event") ?? "";
          if (!event) {
            logWebhook?.("rejected: missing event");
            return error(
              { message: "Missing webhook event type.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          let payload: unknown;
          try {
            payload = JSON.parse(rawBody);
          } catch {
            logWebhook?.("rejected: invalid json");
            return error(
              { message: "Invalid JSON payload.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          if (!isRecord(payload)) {
            logWebhook?.("rejected: payload not object");
            return error(
              { message: "Invalid webhook payload.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          const action =
            typeof payload["action"] === "string" ? (payload["action"] as string) : null;
          const installationPayload = isRecord(payload["installation"])
            ? payload["installation"]
            : null;

          const installationId = toStringValue(
            installationPayload?.["id"] ?? payload["installation_id"],
          );
          if (!installationId) {
            logWebhook?.("rejected: missing installation id");
            return error(
              { message: "Missing installation id.", code: "WEBHOOK_PAYLOAD_INVALID" },
              { status: 400 },
            );
          }

          const now = new Date();
          logWebhook?.("accepted", {
            deliveryId,
            event,
            action,
            installationId,
          });
          const webhookPayload: WebhookProcessingPayload = {
            deliveryId,
            event,
            action,
            installationId,
            payload,
            receivedAt: now.toISOString(),
          };

          try {
            await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(githubAppSchema);
                uow.triggerHook("processWebhook", webhookPayload, { id: deliveryId });
              })
              .execute();
          } catch (err) {
            if (!isUniqueConstraintError(err)) {
              throw err;
            }
          }

          return empty(204);
        },
      }),
    ];
  },
);
