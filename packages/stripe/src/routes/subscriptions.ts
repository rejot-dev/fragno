import { z } from "zod";
import {
  SubscriptionReponseSchema,
  SubscriptionUpgradeRequestSchema,
  type SubscriptionResponse,
} from "../models/subscriptions";
import { stripeToApiError } from "./errors";
import { defineRoutes } from "@fragno-dev/core/api/route";
import { stripeFragmentDefinition } from "../definition";

export const subscriptionsRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ deps, services, config, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/admin/subscriptions",
        outputSchema: z.object({
          subscriptions: z.array(SubscriptionReponseSchema),
        }),
        handler: async (_, { json, error }) => {
          if (!config.enableAdminRoutes) {
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
          "SUBSCRIPTION_UPDATE_NOT_ALLOWED",
          "SUBSCRIPTION_UPDATE_PROMO_CODE_NOT_ALLOWED",
          "PROMOTION_CODE_CUSTOMER_NOT_FIRST_TIME",
          "MULTIPLE_ACTIVE_SUBSCRIPTIONS",
          "NO_ACTIVE_SUBSCRIPTIONS",
        ] as const,
        handler: async (context, { json, error }) => {
          const body = await context.input.valid();
          const entity = await config.resolveEntityFromRequest(context);

          let customerId: string | undefined = entity.stripeCustomerId;
          let existingSubscription: SubscriptionResponse | null = null;

          // Step 1: Get active subscriptions
          if (entity.stripeCustomerId) {
            const existingSubscriptions = await services.getSubscriptionsByStripeCustomerId(
              entity.stripeCustomerId,
            );

            // Cannot upgrade cancelled subscriptions
            let activeSubscriptions = existingSubscriptions.filter((s) => s.status !== "canceled");

            // A specific subscription has been specified
            if (body.subscriptionId) {
              activeSubscriptions = activeSubscriptions.filter((s) => s.id === body.subscriptionId);
            }

            if (activeSubscriptions.length > 1) {
              return error(
                {
                  message:
                    "Multiple active subscriptions found for customer, please specify which subscription to upgrade",
                  code: "MULTIPLE_ACTIVE_SUBSCRIPTIONS",
                },
                400,
              );
            }
            if (activeSubscriptions.length === 0) {
              return error(
                {
                  message: "No active subscriptions found for customer",
                  code: "NO_ACTIVE_SUBSCRIPTIONS",
                },
                400,
              );
            }
            existingSubscription = activeSubscriptions[0];

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
              query: `metadata['referenceId']:'${entity.referenceId}'`,
              limit: 1,
            });

            if (existingLinkedCustomer.data.length === 1) {
              // Use existing customer
              customerId = existingLinkedCustomer.data[0].id;
            } else {
              // Create new Stripe Customer

              // Check if sufficient data is provided for this scenario
              if (!entity.customerEmail || !entity.referenceId) {
                return error({
                  message:
                    "New Stripe Customer must be created, but customerEmail or referenceID has not been provided",
                  code: "MISSING_CUSTOMER_INFO",
                });
              }

              const newCustomer = await deps.stripe.customers.create({
                email: entity.customerEmail,
                metadata: {
                  referenceId: entity.referenceId,
                  ...entity.stripeMetadata,
                },
              });
              customerId = newCustomer.id;
            }

            // Communicate back to the user that a customer has been created/linked
            try {
              await config.onStripeCustomerCreated(customerId, entity.referenceId);
            } catch (error) {
              deps.log.error("onStripeCustomerCreated failed!", error);
            }
          }

          // Step 3: Resolve promotion code to ID if provided
          let promotionCodeId: string | undefined = undefined;
          if (body.promotionCode) {
            const promotionCodes = await deps.stripe.promotionCodes.list({
              code: body.promotionCode,
              active: true,
              limit: 1,
            });
            if (promotionCodes.data.length > 0) {
              promotionCodeId = promotionCodes.data[0].id;
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
              // when /upgrade is called on a subscription scheduled to cancel at the end of the billing period,
              // it is still "active" but it's not possible to renew it using a billing portal.
              if (existingSubscription.cancelAt != null) {
                deps.log.info("un-cancelling subscription", stripeSubscription.id);

                await deps.stripe.subscriptions.update(stripeSubscription.id, {
                  cancel_at_period_end: false,
                });

                return json({
                  url: body.returnUrl || body.successUrl,
                  redirect: true,
                });
              }
              // Portal session to confirm subscription changes
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
                    ...(promotionCodeId && {
                      discounts: [{ promotion_code: promotionCodeId }],
                    }),
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
              referenceId: entity.referenceId,
            },
            ...(promotionCodeId && {
              discounts: [{ promotion_code: promotionCodeId }],
            }),
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
          subscriptionId: z
            .string()
            .optional()
            .describe("Which subscription to cancel, if there are multiple active subscriptions"),
        }),
        outputSchema: z.object({
          url: z.url().describe("URL to redirect to after cancellation"),
          redirect: z.boolean().describe("Whether to redirect to the URL"),
        }),
        errorCodes: [
          "SUBSCRIPTION_NOT_FOUND",
          "NO_SUBSCRIPTION_TO_CANCEL",
          "SUBSCRIPTION_ALREADY_CANCELED",
          "NO_STRIPE_CUSTOMER_LINKED",
          "MULTIPLE_SUBSCRIPTIONS_FOUND",
        ] as const,
        handler: async (context, { json, error }) => {
          const body = await context.input.valid();
          const { stripeCustomerId } = await config.resolveEntityFromRequest(context);

          if (!stripeCustomerId) {
            return error(
              { message: "No stripe customer linked to entity", code: "NO_STRIPE_CUSTOMER_LINKED" },
              400,
            );
          }

          let activeSubscriptions = (
            await services.getSubscriptionsByStripeCustomerId(stripeCustomerId)
          ).filter((s) => s.status === "active");

          // A specific active subscription was requested
          if (body.subscriptionId) {
            activeSubscriptions = activeSubscriptions.filter((s) => s.id === body.subscriptionId);
          }

          if (activeSubscriptions.length === 0) {
            return error(
              { message: "No active subscription to cancel", code: "NO_SUBSCRIPTION_TO_CANCEL" },
              404,
            );
          }

          if (activeSubscriptions.length > 1) {
            return error(
              {
                message: "Multiple active subscriptions found",
                code: "MULTIPLE_SUBSCRIPTIONS_FOUND",
              },
              400,
            );
          }

          const activeSubscription = activeSubscriptions[0];

          try {
            // Get active subscriptions from Stripe for this customer
            const stripeSubscription = await deps.stripe.subscriptions.retrieve(
              activeSubscription.stripeSubscriptionId,
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
              return json({
                url: "", // No redirect needed
                redirect: false,
              });
            }

            // Create billing portal session for cancellation
            const portalSession = await deps.stripe.billingPortal.sessions.create({
              customer: activeSubscription.stripeCustomerId!,
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
  },
);
