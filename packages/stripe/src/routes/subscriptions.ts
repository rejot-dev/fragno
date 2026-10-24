import type Stripe from "stripe";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";
import { decodeCursor, type Cursor } from "@fragno-dev/db";

import { recordCustomerLink, stripeFragmentDefinition } from "../definition";
import { stripeSchema } from "../schema";
import { isOngoing, subscriptionFromRow, subscriptionSchema } from "../subscriptions";
import type { StripeCustomerLink, StripeEntity } from "../types";
import { stripeToApiError } from "./errors";

const upgradeRequestSchema = z.object({
  priceId: z.string().describe("Stripe price ID to subscribe/upgrade to"),
  quantity: z.number().int().positive().default(1).describe("Number of seats"),
  successUrl: z.url().describe("Redirect URL after successful checkout"),
  cancelUrl: z.url().describe("Redirect URL if checkout is cancelled"),
  returnUrl: z.url().optional().describe("Return URL for billing portal"),
  promotionCode: z.string().optional().describe("Promotion code to apply"),
  subscriptionId: z
    .string()
    .optional()
    .describe("Subscription to upgrade; defaults to the entity's only active subscription"),
});

const subscriptionPageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

type UpgradeOutcome =
  | { ok: true; url: string; newLink: StripeCustomerLink | null }
  | {
      ok: false;
      code: "SUBSCRIPTION_NOT_FOUND" | "MULTIPLE_ACTIVE_SUBSCRIPTIONS" | "PROMOTION_CODE_INVALID";
    };

/** Stripe search queries quote string values with single quotes. */
function searchString(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export const subscriptionsRoutesFactory = defineRoutes(stripeFragmentDefinition).create(
  ({ deps, services, config, defineRoute }) => {
    /** A customer an earlier integration created for the entity, found by its metadata. */
    async function findCustomer(entity: StripeEntity): Promise<string | null> {
      const found = await deps.stripe.customers.search({
        query: `metadata['referenceId']:${searchString(entity.referenceId)}`,
        limit: 1,
      });
      return found.data[0]?.id ?? null;
    }

    async function createCustomer(entity: StripeEntity): Promise<string> {
      // Concurrent first upgrades can each create a customer. Only one gets linked; the other
      // requests retry onto the link and leave their customer unused.
      const created = await deps.stripe.customers.create({
        email: entity.customerEmail,
        metadata: { ...entity.customerMetadata, referenceId: entity.referenceId },
      });
      return created.id;
    }

    /**
     * The customer's subscriptions that still bill, as Stripe lists them. Routes decide from these
     * because synced rows lag behind Stripe, and behind links to customers that already existed.
     */
    async function listOngoingSubscriptions(customerId: string) {
      const subscriptions = await deps.stripe.subscriptions.list({
        customer: customerId,
        limit: 100,
      });
      return subscriptions.data.filter(isOngoing);
    }

    async function findPromotionCodeId(code: string): Promise<string | null> {
      const promotionCodes = await deps.stripe.promotionCodes.list({
        code,
        active: true,
        limit: 1,
      });
      return promotionCodes.data[0]?.id ?? null;
    }

    return [
      defineRoute({
        method: "GET",
        path: "/admin/subscriptions",
        queryParameters: ["cursor", "pageSize"],
        outputSchema: z.object({
          subscriptions: z.array(subscriptionSchema),
          cursor: z.string().nullable(),
          hasNextPage: z.boolean(),
        }),
        errorCodes: ["INVALID_QUERY"] as const,
        handler: async function ({ query }, { json, error }) {
          const invalidQuery = () =>
            error(
              {
                message:
                  "pageSize must be a whole number from 1 to 100 and cursor a returned cursor",
                code: "INVALID_QUERY",
              },
              400,
            );
          const parsed = subscriptionPageQuerySchema.safeParse({
            cursor: query.get("cursor") ?? undefined,
            pageSize: query.get("pageSize") ?? undefined,
          });
          if (!parsed.success) {
            return invalidQuery();
          }
          let cursor: Cursor | undefined;
          try {
            cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : undefined;
          } catch {
            return invalidQuery();
          }
          const pageSize = parsed.data.pageSize ?? 50;

          const page = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(stripeSchema).findWithCursor("subscription", (b) => {
                const ordered = b
                  .whereIndex("primary")
                  .orderByIndex("primary", "asc")
                  .pageSize(pageSize);
                return cursor ? ordered.after(cursor) : ordered;
              }),
            )
            .transformRetrieve(([page]) => ({
              subscriptions: page.items.map(subscriptionFromRow),
              cursor: page.cursor?.encode() ?? null,
              hasNextPage: page.hasNextPage,
            }))
            .execute();

          return json(page);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/subscription/upgrade",
        inputSchema: upgradeRequestSchema,
        outputSchema: z.object({ url: z.url().describe("URL to redirect the entity to") }),
        errorCodes: [
          "UNAUTHENTICATED",
          "SUBSCRIPTION_NOT_FOUND",
          "MULTIPLE_ACTIVE_SUBSCRIPTIONS",
          "PROMOTION_CODE_INVALID",
          "UPGRADE_HAS_NO_EFFECT",
          "SUBSCRIPTION_UPDATE_NOT_ALLOWED",
          "SUBSCRIPTION_UPDATE_PROMO_CODE_NOT_ALLOWED",
          "PROMOTION_CODE_CUSTOMER_NOT_FIRST_TIME",
        ] as const,
        handler: async function (context, { json, error }) {
          const body = await context.input.valid();
          const entity = await config.resolveEntityFromRequest(context);
          if (!entity) {
            return error({ message: "Not authenticated", code: "UNAUTHENTICATED" }, 401);
          }
          const returnUrl = body.returnUrl ?? body.successUrl;

          let outcome: UpgradeOutcome;
          try {
            outcome = await this.handlerTx()
              .withServiceCalls(
                () => [services.getCustomerByReferenceId(entity.referenceId)] as const,
              )
              .transformRetrieve(async (_, [linkedCustomer]) => {
                const existingCustomerId =
                  linkedCustomer?.customerId ?? (await findCustomer(entity));
                const ongoing = existingCustomerId
                  ? await listOngoingSubscriptions(existingCustomerId)
                  : [];
                const candidates = ongoing.filter(
                  (subscription) => !body.subscriptionId || subscription.id === body.subscriptionId,
                );
                if (body.subscriptionId && candidates.length === 0) {
                  return { ok: false, code: "SUBSCRIPTION_NOT_FOUND" } as const;
                }
                if (candidates.length > 1) {
                  return { ok: false, code: "MULTIPLE_ACTIVE_SUBSCRIPTIONS" } as const;
                }

                let discounts: { promotion_code: string }[] | undefined;
                if (body.promotionCode) {
                  const promotionCodeId = await findPromotionCodeId(body.promotionCode);
                  if (!promotionCodeId) {
                    return { ok: false, code: "PROMOTION_CODE_INVALID" } as const;
                  }
                  discounts = [{ promotion_code: promotionCodeId }];
                }

                const customerId = existingCustomerId ?? (await createCustomer(entity));
                // Customers found by search name the entity in their metadata, so their synced
                // subscriptions already belong to it.
                const newLink = linkedCustomer
                  ? null
                  : { customerId, referenceId: entity.referenceId };

                const subscription = candidates[0];
                if (subscription?.cancel_at_period_end) {
                  // The portal cannot change a subscription that is scheduled to cancel, so
                  // upgrading it means resuming it.
                  await deps.stripe.subscriptions.update(subscription.id, {
                    cancel_at_period_end: false,
                  });
                  return { ok: true, url: returnUrl, newLink } as const;
                }

                if (subscription) {
                  const portalSession = await deps.stripe.billingPortal.sessions.create({
                    customer: customerId,
                    return_url: returnUrl,
                    flow_data: {
                      type: "subscription_update_confirm",
                      after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
                      subscription_update_confirm: {
                        subscription: subscription.id,
                        items: [
                          {
                            id: subscription.items.data[0].id,
                            quantity: body.quantity,
                            price: body.priceId,
                          },
                        ],
                        discounts,
                      },
                    },
                  });
                  return { ok: true, url: portalSession.url, newLink } as const;
                }

                const checkoutParams: Stripe.Checkout.SessionCreateParams = {
                  mode: "subscription",
                  customer: customerId,
                  client_reference_id: entity.referenceId,
                  success_url: body.successUrl,
                  cancel_url: body.cancelUrl,
                  line_items: [{ price: body.priceId, quantity: body.quantity }],
                  subscription_data: { metadata: { referenceId: entity.referenceId } },
                  discounts,
                };
                const checkoutSession = await deps.stripe.checkout.sessions.create(checkoutParams);
                // Hosted checkout sessions always have a URL.
                const url = checkoutSession.url!;
                return { ok: true, url, newLink } as const;
              })
              .mutate(({ forSchema, retrieveResult }): UpgradeOutcome => {
                if (retrieveResult.ok && retrieveResult.newLink) {
                  recordCustomerLink(forSchema(stripeSchema), retrieveResult.newLink);
                }
                return retrieveResult;
              })
              .execute();
          } catch (err) {
            throw stripeToApiError(err);
          }

          if (!outcome.ok) {
            const messages = {
              SUBSCRIPTION_NOT_FOUND: "No active subscription with this ID",
              MULTIPLE_ACTIVE_SUBSCRIPTIONS:
                "Multiple active subscriptions found, specify which subscription to upgrade",
              PROMOTION_CODE_INVALID: "Promotion code does not exist or is no longer active",
            };
            return error({ message: messages[outcome.code], code: outcome.code }, 400);
          }
          return json({ url: outcome.url });
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
        outputSchema: z.object({ url: z.url().describe("URL to redirect the entity to") }),
        errorCodes: [
          "UNAUTHENTICATED",
          "NO_SUBSCRIPTION_TO_CANCEL",
          "MULTIPLE_SUBSCRIPTIONS_FOUND",
          "SUBSCRIPTION_ALREADY_CANCELED",
        ] as const,
        handler: async function (context, { json, error }) {
          const body = await context.input.valid();
          const entity = await config.resolveEntityFromRequest(context);
          if (!entity) {
            return error({ message: "Not authenticated", code: "UNAUTHENTICATED" }, 401);
          }

          let outcome:
            | { ok: true; url: string; newLink: StripeCustomerLink | null }
            | {
                ok: false;
                code:
                  | "NO_SUBSCRIPTION_TO_CANCEL"
                  | "MULTIPLE_SUBSCRIPTIONS_FOUND"
                  | "SUBSCRIPTION_ALREADY_CANCELED";
              };
          try {
            outcome = await this.handlerTx()
              .withServiceCalls(
                () => [services.getCustomerByReferenceId(entity.referenceId)] as const,
              )
              .transformRetrieve(async (_, [linkedCustomer]) => {
                const customerId = linkedCustomer?.customerId ?? (await findCustomer(entity));
                const ongoing = customerId ? await listOngoingSubscriptions(customerId) : [];
                const candidates = ongoing.filter(
                  (subscription) => !body.subscriptionId || subscription.id === body.subscriptionId,
                );
                const subscription = candidates[0];
                if (!customerId || !subscription) {
                  return { ok: false, code: "NO_SUBSCRIPTION_TO_CANCEL" } as const;
                }
                if (candidates.length > 1) {
                  return { ok: false, code: "MULTIPLE_SUBSCRIPTIONS_FOUND" } as const;
                }
                if (subscription.cancel_at_period_end) {
                  return { ok: false, code: "SUBSCRIPTION_ALREADY_CANCELED" } as const;
                }

                const portalSession = await deps.stripe.billingPortal.sessions.create({
                  customer: customerId,
                  return_url: body.returnUrl,
                  flow_data: {
                    type: "subscription_cancel",
                    subscription_cancel: { subscription: subscription.id },
                    after_completion: {
                      type: "redirect",
                      redirect: { return_url: body.returnUrl },
                    },
                  },
                });
                return {
                  ok: true,
                  url: portalSession.url,
                  newLink: linkedCustomer ? null : { customerId, referenceId: entity.referenceId },
                } as const;
              })
              .mutate(({ forSchema, retrieveResult }) => {
                if (retrieveResult.ok && retrieveResult.newLink) {
                  recordCustomerLink(forSchema(stripeSchema), retrieveResult.newLink);
                }
                return retrieveResult;
              })
              .execute();
          } catch (err) {
            throw stripeToApiError(err);
          }

          if (!outcome.ok) {
            const responses = {
              NO_SUBSCRIPTION_TO_CANCEL: {
                message: "No active subscription to cancel",
                status: 404,
              },
              MULTIPLE_SUBSCRIPTIONS_FOUND: {
                message: "Multiple active subscriptions found, specify which one to cancel",
                status: 400,
              },
              SUBSCRIPTION_ALREADY_CANCELED: {
                message: "Subscription is already set to be canceled at period end",
                status: 409,
              },
            } as const;
            const { message, status } = responses[outcome.code];
            return error({ message, code: outcome.code }, status);
          }
          return json({ url: outcome.url });
        },
      }),
    ];
  },
);
