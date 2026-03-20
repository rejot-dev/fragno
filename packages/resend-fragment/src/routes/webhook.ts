import { z } from "zod";

import { resendSchema } from "../schema";
import type { ResendRouteFactoryContext } from "./context";
import { formatErrorMessage } from "./shared";

const resendWebhookResponseSchema = z.object({
  success: z.boolean(),
});

export const registerWebhookRoutes = ({ defineRoute, config, deps }: ResendRouteFactoryContext) => [
  defineRoute({
    method: "POST",
    path: "/resend/webhook",
    outputSchema: resendWebhookResponseSchema,
    errorCodes: ["MISSING_SIGNATURE", "WEBHOOK_SIGNATURE_INVALID", "WEBHOOK_ERROR"] as const,
    handler: async function ({ headers, rawBody }, { json, error }) {
      if (!config.webhookSecret) {
        return error(
          {
            message: "Missing webhook secret in config",
            code: "WEBHOOK_ERROR",
          },
          400,
        );
      }

      const id = headers.get("svix-id");
      const timestamp = headers.get("svix-timestamp");
      const signature = headers.get("svix-signature");

      if (!id || !timestamp || !signature) {
        return error(
          {
            message: "Missing signature headers",
            code: "MISSING_SIGNATURE",
          },
          400,
        );
      }

      if (!rawBody) {
        return error(
          {
            message: "Missing request body for webhook verification",
            code: "WEBHOOK_ERROR",
          },
          400,
        );
      }

      let event;
      try {
        event = deps.resend.webhooks.verify({
          payload: rawBody,
          headers: {
            id,
            timestamp,
            signature,
          },
          webhookSecret: config.webhookSecret,
        });
      } catch (err) {
        return error(
          {
            message: formatErrorMessage(err),
            code: "WEBHOOK_SIGNATURE_INVALID",
          },
          400,
        );
      }

      await this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(resendSchema);
          uow.triggerHook("onResendWebhook", { event });
        })
        .execute();

      return json({ success: true });
    },
  }),
];
