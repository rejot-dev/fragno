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
      handler: async ({ headers }, { json, error }) => {
        const user = await config.authMiddleware.getUserData(headers);
        if (!user || !user.isAdmin) {
          return error({ message: "Unauthorized", code: "UNAUTHORIZED" }, 401);
        }

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
      handler: async ({ input, headers }, { json, error }) => {
        const body = await input.valid();
        const user = await config.authMiddleware.getUserData(headers);

        let customerId: string | undefined = user.stripeCustomerId;
        let existingSubscription: SubscriptionResponse | null = null;

        // Step 1: Check if upgrading or creating subscription
        if (user.subscriptionId) {
          existingSubscription = await services.getSubscriptionById(user.subscriptionId);

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
            customerId &&
            existingSubscription.stripeCustomerId &&
            existingSubscription.stripeCustomerId !== customerId
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
            query: `metadata['referenceId']:'${user.referenceId}'`,
            limit: 1,
          });

          if (existingLinkedCustomer.data.length === 1) {
            // Use existing customer
            customerId = existingLinkedCustomer.data[0].id;
          } else {
            // Create new Stripe Customer

            // Check if sufficient data is provided for this scenario
            if (!user.customerEmail || !user.referenceId) {
              return error({
                message:
                  "New Stripe Customer must be created, but customerEmail or referenceID has not been provide",
                code: "MISSING_CUSTOMER_INFO",
              });
            }

            const newCustomer = await deps.stripe.customers.create({
              email: user.customerEmail,
              metadata: {
                referenceId: user.referenceId,
                ...user.stripeMetadata,
              },
            });
            customerId = newCustomer.id;
          }

          // Communicate back to the user that a customer has been created/linked
          try {
            await config.onStripeCustomerCreated(customerId, user.referenceId);
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
          } catch (error: unknown) {
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
            referenceId: user.referenceId,
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
        returnUrl: z.url().describe("URL to redirect to after cancellation is complete"),
      }),
      outputSchema: z.object({
        url: z.url().describe("URL to redirect to after cancellation"),
        redirect: z.boolean().describe("Whether to redirect to the URL"),
      }),
      errorCodes: [
        "SUBSCRIPTION_NOT_FOUND",
        "NO_SUBSCRIPTION_TO_CANCEL",
        "SUBSCRIPTION_ALREADY_CANCELED",
      ] as const,
      handler: async ({ input, headers }, { json, error }) => {
        const body = await input.valid();
        const { subscriptionId } = await config.authMiddleware.getUserData(headers);

        if (!subscriptionId) {
          return error(
            { message: "No subscription to cancel", code: "NO_SUBSCRIPTION_TO_CANCEL" },
            404,
          );
        }

        // Get the subscription from our database
        const subscription = await services.getSubscriptionById(subscriptionId);

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
        } catch (err: unknown) {
          throw stripeToApiError(err);
        }
      },
    }),
  ];
});
