import { z } from "zod";

import type { OverrideDefinition } from "@/fragno/overrides/definition";

/** Flags turn code on and off while it rolls out, on any scope; remove them once it ships. */
function featureFlag(input: { description: string; default: boolean }) {
  return {
    ...input,
    schema: z.boolean(),
    scopes: ["system", "org", "user", "app", "project"],
  } satisfies OverrideDefinition<z.ZodBoolean>;
}

export const featureFlagDefinitions = {
  "organization-access-summary": featureFlag({
    description: "Show the organization access summary on the organization overview.",
    default: true,
  }),
  "scope-probe": featureFlag({
    description:
      "Show a badge in the top bar naming the scope whose override turned this flag on, to check feature flags live.",
    default: false,
  }),
};

export type FeatureFlagKey = keyof typeof featureFlagDefinitions;
export const featureFlagKeySchema = z.enum(Object.keys(featureFlagDefinitions) as FeatureFlagKey[]);
