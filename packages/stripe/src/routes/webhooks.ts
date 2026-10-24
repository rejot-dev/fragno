import Stripe from "stripe";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { isUniqueConstraintError } from "@fragno-dev/db";

import { stripeFragmentDefinition } from "../definition";
import { stripeSchema } from "../schema";

export const webhookRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ config, deps, defineRoute }) => {
    return [
      defineRoute({
        method: "POST",
        path: "/webhook",
        outputSchema: z.object({
          success: z.boolean(),
        }),
        errorCodes: ["MISSING_SIGNATURE", "WEBHOOK_SIGNATURE_INVALID"] as const,
        handler: async function ({ headers, rawBody }, { json, error }) {
          const signature = headers.get("stripe-signature");
          if (!signature) {
            return error(
              { message: "Missing stripe-signature header", code: "MISSING_SIGNATURE" },
              400,
            );
          }

          let event: Stripe.Event;
          try {
            event = await deps.stripe.webhooks.constructEventAsync(
              rawBody ?? "",
              signature,
              config.webhookSecret,
            );
          } catch (err) {
            if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
              return error(
                {
                  message: "Webhook signature verification failed",
                  code: "WEBHOOK_SIGNATURE_INVALID",
                },
                400,
              );
            }
            throw err;
          }

          try {
            await this.handlerTx()
              .mutate(({ forSchema }) => {
                const uow = forSchema(stripeSchema);
                uow.triggerHook(
                  "processStripeEvent",
                  { event },
                  { id: `stripe-event:${event.id}` },
                );
                uow.triggerHook("deliverStripeEvent", { event });
              })
              .execute();
          } catch (err) {
            // Stripe redelivers events; the hook ID recorded the first delivery already.
            if (!isUniqueConstraintError(err)) {
              throw err;
            }
          }

          return json({ success: true });
        },
      }),
    ];
  },
);
