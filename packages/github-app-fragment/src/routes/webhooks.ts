import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { githubAppFragmentDefinition } from "../github/definition";
import type { GitHubAppWebhookDelivery } from "../github/types";
import { webhookDeliveryOfRow } from "../github/webhook-processing";
import { githubAppSchema } from "../schema";
import { isRecord, toDebugSignature, toStringValue } from "./shared";

/** More than one, so a backlog of expired deliveries drains while new ones arrive. */
const EXPIRED_DELIVERIES_DELETED_PER_DELIVERY = 10;

const webhookDeliveryOutputSchema = z.object({
  deliveryId: z.string(),
  event: z.string(),
  action: z.string().nullable(),
  installationId: z.string(),
  receivedAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<GitHubAppWebhookDelivery>;

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

          const action = typeof payload["action"] === "string" ? payload["action"] : null;
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

          const receivedAt = new Date();
          const expiredBefore = new Date(receivedAt.getTime() - deps.webhookDeliveryRetentionMs);
          logWebhook?.("accepted", {
            deliveryId,
            event,
            action,
            installationId,
          });

          try {
            await this.handlerTx()
              .retrieve(({ forSchema }) =>
                forSchema(githubAppSchema).find("webhook_delivery", (b) =>
                  b
                    .whereIndex("idx_webhook_delivery_processedAt", (eb) =>
                      eb("processedAt", "<", expiredBefore),
                    )
                    .orderByIndex("idx_webhook_delivery_processedAt", "asc")
                    .select(["id"])
                    .pageSize(EXPIRED_DELIVERIES_DELETED_PER_DELIVERY),
                ),
              )
              .mutate(({ forSchema, retrieveResult: [expiredDeliveries] }) => {
                const uow = forSchema(githubAppSchema);
                uow.create("webhook_delivery", {
                  id: deliveryId,
                  event,
                  action,
                  installationId,
                  receivedAt,
                  payload,
                });
                uow.deleteMany(
                  "webhook_delivery",
                  expiredDeliveries.map((delivery) => delivery.id),
                );
                uow.triggerHook("processWebhook", { deliveryId }, { id: deliveryId });
              })
              .execute();
          } catch (err) {
            // GitHub redelivers with the same delivery ID, which the stored delivery already has.
            if (!isUniqueConstraintError(err)) {
              throw err;
            }
          }

          return empty(204);
        },
      }),
      defineRoute({
        method: "GET",
        path: "/webhooks/deliveries/:deliveryId",
        outputSchema: webhookDeliveryOutputSchema,
        errorCodes: ["WEBHOOK_DELIVERY_NOT_FOUND"],
        handler: async function ({ pathParams }, { json, error }) {
          const [delivery] = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(githubAppSchema).findFirst("webhook_delivery", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.deliveryId)),
              ),
            )
            .execute();
          if (!delivery) {
            return error(
              {
                message: "Webhook delivery not found; it was never received or has expired.",
                code: "WEBHOOK_DELIVERY_NOT_FOUND",
              },
              { status: 404 },
            );
          }
          return json(webhookDeliveryOfRow(delivery));
        },
      }),
    ];
  },
);
