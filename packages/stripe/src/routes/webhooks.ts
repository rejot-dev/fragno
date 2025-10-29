import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import Stripe from "stripe";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import { eventToHandler, type SupportedStripeEvent } from "../webhook/handlers";

export const webhookRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ config, deps, services }) => {
  return [
    defineRoute({
      method: "POST",
      path: "/webhook",
      outputSchema: z.object({
        success: z.boolean(),
      }),
      errorCodes: ["MISSING_SIGNATURE", "WEBHOOK_SIGNATURE_INVALID", "WEBHOOK_ERROR"] as const,
      handler: async ({ headers, rawBody }, { json, error }) => {
        // Get the signature
        const signature = headers.get("stripe-signature");

        if (!signature) {
          return error(
            { message: "Missing stripe-signature header", code: "MISSING_SIGNATURE" },
            400,
          );
        }

        if (!rawBody) {
          return error(
            { message: "Missing request body for webhook verification", code: "WEBHOOK_ERROR" },
            400,
          );
        }

        // Verify the webhook signature
        let event: Stripe.Event;
        try {
          // Support both Stripe v18 (constructEvent) and v19+ (constructEventAsync)
          if (typeof deps.stripe.webhooks.constructEventAsync === "function") {
            // Stripe v19+ - use async method
            event = await deps.stripe.webhooks.constructEventAsync(
              rawBody,
              signature,
              config.webhookSecret,
            );
          } else {
            // Stripe v18 - use sync method
            event = deps.stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
          }
        } catch (err) {
          if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
            return error(
              {
                message: `Webhook signature verification failed`,
                code: "WEBHOOK_SIGNATURE_INVALID",
              },
              400,
            );
          }
          throw err;
        }

        if (!event) {
          return error({ message: "Failed to construct event", code: "WEBHOOK_ERROR" }, 400);
        }

        if (config.onEvent) {
          deps.log.info("Running user callback event");
          await config.onEvent({ event, stripeClient: deps.stripe });
        }

        const eventHandler = eventToHandler[event.type as SupportedStripeEvent];
        if (!eventHandler) {
          deps.log.info(`Webhook event ${event.type}: ${event.id} ignored`);
          return json({ success: true });
        }

        deps.log.info(`Executing event handler for ${event.type}: ${event.id}`);
        await eventHandler({ event, services, deps, config });

        return json({ success: true });
      },
    }),
  ];
});
