import { defineRoute, defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import Stripe from "stripe";
import type { StripeFragmentConfig, StripeFragmentDeps, StripeFragmentServices } from "../types";
import { SubscriptionReponseSchema } from "../models/subscriptions";

export const subscriptionsRoutesFactory = defineRoutes<
  StripeFragmentConfig,
  StripeFragmentDeps,
  StripeFragmentServices
>().create(({ config, deps, services }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/subscriptions",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(20)
          .describe("Number of subscriptions to return (max 100)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Number of subscriptions to skip for pagination"),
      }),
      outputSchema: z.object({
        subscriptions: z.array(SubscriptionReponseSchema),
      }),
      errorCodes: ["SUBSCRIPTIONS_FETCH_FAILED"] as const,
      handler: async (_, { json }) => {
        return json({
          subscriptions: await services.getAllSubscriptions(),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/subscription/upgrade",
      inputSchema: z.object({
        userId: z.string().describe("The user ID for the subscription"),
        priceId: z.string().describe("Stripe price ID to subscribe/upgrade to"),
        quantity: z.number().positive().optional().default(1).describe("Number of seats"),
        customerEmail: z.email().optional().describe("Email for new Stripe customers"), // TODO: from backend
        customerName: z.string().optional().describe("Name for new Stripe customers"), // TODO: from backend
        metadata: z
          .record(z.string(), z.string())
          .optional()
          .describe("Custom metadata for the subscription"),
        successUrl: z.url().describe("Redirect URL after successful checkout"),
        cancelUrl: z.url().describe("Redirect URL if checkout is cancelled"),
        returnUrl: z.string().optional().describe("Return URL for billing portal"),
        disableRedirect: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return URL without auto-redirecting"),
      }),
      outputSchema: z.object({
        url: z.string(),
        redirect: z.boolean(),
        sessionId: z.string().optional(),
      }),
      errorCodes: [
        "CUSTOMER_CREATION_FAILED",
        "CHECKOUT_SESSION_FAILED",
        "BILLING_PORTAL_FAILED",
        "MISSING_CUSTOMER_INFO",
      ] as const,
      handler: async ({ input }, { json, error }) => {
        const body = await input.valid();

        // Step 1: Find existing customer by userId in metadata
        let customerId: string | null = null;
        try {
          const customers = await deps.stripe.customers.search({
            query: `metadata['userId']:'${body.userId}'`,
            limit: 1,
          });

          if (customers.data.length > 0) {
            customerId = customers.data[0]!.id;
          }
        } catch (err) {
          console.error("Error searching for customer:", err);
        }

        // Step 2: Create customer if not found
        if (!customerId) {
          if (!body.customerEmail) {
            return error(
              {
                message: "customerEmail is required when creating a new customer",
                code: "MISSING_CUSTOMER_INFO",
              },
              400,
            );
          }

          try {
            const customerMetadata = config.getCustomerMetadata
              ? await config.getCustomerMetadata(body.userId)
              : {};

            const customer = await deps.stripe.customers.create({
              email: body.customerEmail,
              name: body.customerName,
              metadata: {
                userId: body.userId,
                ...customerMetadata,
                ...body.metadata,
              },
            });

            customerId = customer.id;
          } catch (err) {
            console.error("Failed to create Stripe customer:", err);
            return error(
              {
                message: `Failed to create customer: ${err instanceof Error ? err.message : "Unknown error"}`,
                code: "CUSTOMER_CREATION_FAILED",
              },
              500,
            );
          }
        }

        // Step 3: Check for active/trialing subscriptions
        let activeSubscription: Stripe.Subscription | null = null;
        try {
          const subscriptions = await deps.stripe.subscriptions.list({
            customer: customerId,
            status: "active",
            limit: 1,
          });

          if (subscriptions.data.length > 0) {
            activeSubscription = subscriptions.data[0]!;
          } else {
            // Also check for trialing subscriptions
            const trialingSubscriptions = await deps.stripe.subscriptions.list({
              customer: customerId,
              status: "trialing",
              limit: 1,
            });

            if (trialingSubscriptions.data.length > 0) {
              activeSubscription = trialingSubscriptions.data[0]!;
            }
          }
        } catch (err) {
          console.error("Error fetching subscriptions:", err);
        }

        // Step 4: If active subscription exists, use billing portal
        if (activeSubscription) {
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
                  subscription: activeSubscription.id,
                  items: [
                    {
                      id: activeSubscription.items.data[0]?.id as string,
                      quantity: body.quantity,
                      price: body.priceId,
                    },
                  ],
                },
              },
            });

            await config.onUpgradeBillingPortalCreated?.({
              portalSession,
              userId: body.userId,
              stripeClient: deps.stripe,
            });

            return json({
              url: portalSession.url,
              redirect: !body.disableRedirect,
            });
          } catch (err) {
            console.error("Failed to create billing portal session:", err);
            return error(
              {
                message: `Failed to create billing portal: ${err instanceof Error ? err.message : "Unknown error"}`,
                code: "BILLING_PORTAL_FAILED",
              },
              500,
            );
          }
        }

        // Step 5: Create checkout session for new subscription
        try {
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
              userId: body.userId,
              ...body.metadata,
            },
          });

          await config.onUpgradeCheckoutCreated?.({
            checkoutSession,
            userId: body.userId,
            stripeClient: deps.stripe,
          });

          return json({
            url: checkoutSession.url!,
            redirect: !body.disableRedirect,
            sessionId: checkoutSession.id,
          });
        } catch (err) {
          console.error("Failed to create checkout session:", err);
          return error(
            {
              message: `Failed to create checkout session: ${err instanceof Error ? err.message : "Unknown error"}`,
              code: "CHECKOUT_SESSION_FAILED",
            },
            500,
          );
        }
      },
    }),
  ];
});
