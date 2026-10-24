import { z } from "zod";

export const stripeListQueryParameters = ["limit", "startingAfter"] as const;

const stripeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  startingAfter: z.string().min(1).optional().describe("ID of the last item of the previous page"),
});

/** Stripe's own cursor pagination as list parameters, or null when the query is invalid. */
export function stripeListParams(query: URLSearchParams) {
  const parsed = stripeListQuerySchema.safeParse({
    limit: query.get("limit") ?? undefined,
    startingAfter: query.get("startingAfter") ?? undefined,
  });
  if (!parsed.success) {
    return null;
  }
  return { limit: parsed.data.limit ?? 50, starting_after: parsed.data.startingAfter };
}

export const invalidQueryMessage =
  "limit must be a whole number from 1 to 100 and startingAfter must not be empty";
