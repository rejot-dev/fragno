import { z } from "zod";

import type { OverrideDefinition } from "@/fragno/overrides/definition";

/** What an account may do beyond the defaults, granted by administrators for good. */
export const entitlementDefinitions = {
  // Mailboxes belong to people, so the grant does too.
  "email.recipients": {
    description:
      "Who a person's address may send new email to: only their own account email and verified senders they reply to, or anyone.",
    schema: z.enum(["own-and-verified-senders", "anyone"]),
    default: "own-and-verified-senders",
    scopes: ["system", "user"],
  },
} satisfies Record<string, OverrideDefinition>;

export type EntitlementKey = keyof typeof entitlementDefinitions;
export const entitlementKeySchema = z.enum(Object.keys(entitlementDefinitions) as EntitlementKey[]);

export type EntitlementValue<TKey extends EntitlementKey> = z.output<
  (typeof entitlementDefinitions)[TKey]["schema"]
>;
