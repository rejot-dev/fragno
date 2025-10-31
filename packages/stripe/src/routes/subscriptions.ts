import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import {
  SubscriptionReponseSchema,
  SubscriptionUpgradeRequestSchema,
  type SubscriptionResponse,
} from "../models/subscriptions";
import { stripeToApiError } from "./errors";

export const subscriptionsRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ deps, services, config }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/admin/subscriptions",
      outputSchema: z.object({
        subscriptions: z.array(SubscriptionReponseSchema),
      }),
      handler: async (_, { json }) => {
        // TODO: Implement pagination
        return json({
          subscriptions: await services.getAllSubscriptions(),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/subscription/upgrade",
      inputSchema: SubscriptionUpgradeRequestSchema,
      outputSchema: z.object({
        url: z.string(),
        redirect: z.boolean(),
        sessionId: z.string().optional(),
      }),
      errorCodes: [
        "MISSING_CUSTOMER_INFO",
        "SUBSCRIPTION_NOT_FOUND",
        "CUSTOMER_SUBSCRIPTION_MISMATCH",
        "UPGRADE_HAS_NO_EFFECT",
      ] as const,
      handler: async ({ input }, { json, error }) => {
        const body = await input.valid();

        let customerId: string | undefined = body.stripeCustomerId;
        let existingSubscription: SubscriptionResponse | null = null;

        // Step 1: Check if upgrading or creating subscription
        if (body.subscriptionId) {
          existingSubscription = await services.getSubscriptionById(body.subscriptionId);

          if (!existingSubscription) {
            return error(
              {
                message: "Could not retrieve existing subscription",
                code: "SUBSCRIPTION_NOT_FOUND",
              },
              404,
            );
          }

          if (
            body.stripeCustomerId &&
            existingSubscription.stripeCustomerId &&
            existingSubscription.stripeCustomerId !== body.stripeCustomerId
          ) {
            return error(
              {
                message:
                  "Subsciption being updated does not belong to Stripe Customer that was provided",
                code: "CUSTOMER_SUBSCRIPTION_MISMATCH",
              },
              422,
            );
          }

          customerId = existingSubscription.stripeCustomerId;
        }

        // Step 2: Get or Create customer if not found
        if (!customerId) {
          const existingLinkedCustomer = await deps.stripe.customers.search({
            query: `metadata['referenceId']:'${body.referenceId}'`,
            limit: 1,
          });

          if (existingLinkedCustomer.data.length === 1) {
            // Use existing customer
            customerId = existingLinkedCustomer.data[0].id;
          } else {
            // Create new Stripe Customer

            // Check if sufficient data is provided for this scenario
            if (!body.customerEmail || !body.referenceId) {
              return error({
                message:
                  "New Stripe Customer must be created, but customerEmail or referenceID has not been provide",
                code: "MISSING_CUSTOMER_INFO",
              });
            }

            const newCustomer = await deps.stripe.customers.create({
              email: body.customerEmail,
              metadata: {
                referenceId: body.referenceId,
                ...body.stripeMetadata,
              },
            });
            customerId = newCustomer.id;
          }

          // Communicate back to the user that a customer has been created/linked
          try {
            await config.onStripeCustomerCreated(customerId, body.referenceId);
          } catch (error) {
            deps.log.error("onStripeCustomerCreated failed!", error);
          }
        }

        // Step 4: If existing subscription is active, modify using billing portal
        if (
          existingSubscription?.status === "active" ||
          existingSubscription?.status === "trialing"
        ) {
          const stripeSubscription = await deps.stripe.subscriptions.retrieve(
            existingSubscription.stripeSubscriptionId,
          );

          try {
            const portalSession = await deps.stripe.billingPortal.sessions.create({
              customer: customerId,
              return_url: body.returnUrl || body.successUrl,
              flow_data: {
                type: "subscription_update_confirm",
                after_completion: {
                  type: "redirect",
                  redirect: {
                    return_url: body.returnUrl || body.successUrl,
                  },
                },
                subscription_update_confirm: {
                  subscription: existingSubscription.stripeSubscriptionId,
                  items: [
                    {
                      // We always create subscriptions with a single item
                      id: stripeSubscription.items.data[0]?.id as string,
                      quantity: body.quantity,
                      price: body.priceId,
                    },
                  ],
                },
              },
            });
            return json({
              url: portalSession.url,
              redirect: true,
            });
          } catch (error: any) {
            throw stripeToApiError(error);
          }
        }

        // Step 5: Create a Subscription
        const checkoutSession = await deps.stripe.checkout.sessions.create({
          customer: customerId,
          success_url: body.successUrl,
          cancel_url: body.cancelUrl,
          line_items: [
            {
              price: body.priceId,
              quantity: body.quantity,
            },
          ],
          mode: "subscription",
          metadata: {
            referenceId: body.referenceId,
            ...body.stripeMetadata,
          },
        });

        return json({
          url: checkoutSession.url!,
          redirect: true,
          sessionId: checkoutSession.id,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/subscription/cancel",
      inputSchema: z.object({
        subscriptionId: z.string().describe("Internal subscription ID to cancel"),
        returnUrl: z.url().describe("URL to redirect to after cancellation is complete"),
      }),
      outputSchema: z.object({
        url: z.url().describe("URL to redirect to after cancellation"),
        redirect: z.boolean().describe("Whether to redirect to the URL"),
      }),
      errorCodes: ["SUBSCRIPTION_NOT_FOUND", "SUBSCRIPTION_ALREADY_CANCELED"] as const,
      handler: async ({ input }, { json, error }) => {
        const body = await input.valid();

        // Get the subscription from our database
        const subscription = await services.getSubscriptionById(body.subscriptionId);

        if (!subscription) {
          return error(
            {
              message: "Subscription not found",
              code: "SUBSCRIPTION_NOT_FOUND",
            },
            404,
          );
        }

        // Check if already canceled
        if (subscription.status === "canceled") {
          return error(
            {
              message: "Subscription is already canceled",
              code: "SUBSCRIPTION_ALREADY_CANCELED",
            },
            400,
          );
        }

        try {
          // Get active subscriptions from Stripe for this customer
          const activeSubscriptions = await deps.stripe.subscriptions.list({
            customer: subscription.stripeCustomerId,
            status: "active",
          });

          // Find the specific subscription in Stripe
          const stripeSubscription = activeSubscriptions.data.find(
            (sub) => sub.id === subscription.stripeSubscriptionId,
          );

          if (!stripeSubscription) {
            return error(
              {
                message: "Active subscription not found in Stripe",
                code: "SUBSCRIPTION_NOT_FOUND",
              },
              404,
            );
          }

          // Check if subscription is already set to cancel at period end
          if (stripeSubscription.cancel_at_period_end) {
            // Already scheduled for cancellation, just return success
            // Optionally update our database to reflect this state
            return json({
              url: "", // No redirect needed
              redirect: false,
            });
          }

          // Create billing portal session for cancellation
          const portalSession = await deps.stripe.billingPortal.sessions.create({
            customer: subscription.stripeCustomerId!,
            return_url: body.returnUrl,
            flow_data: {
              type: "subscription_cancel",
              subscription_cancel: {
                subscription: stripeSubscription.id,
              },
              after_completion: {
                type: "redirect",
                redirect: {
                  return_url: body.returnUrl,
                },
              },
            },
          });

          return json({
            url: portalSession.url,
            redirect: true,
          });
        } catch (err: any) {
          throw stripeToApiError(err);
        }
      },
    }),
  ];
});
