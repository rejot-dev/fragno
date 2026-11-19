import { z } from "zod";

export const featureFlagDefinitions = {
  "organization-access-summary": {
    description: "Show the organization access summary on the organization overview.",
    defaultEnabled: true,
  },
} satisfies Record<string, { description: string; defaultEnabled: boolean }>;

export type FeatureFlagKey = keyof typeof featureFlagDefinitions;
export const featureFlagKeySchema = z.enum(Object.keys(featureFlagDefinitions) as FeatureFlagKey[]);

export const featureFlagStatusSchema = z.strictObject({
  key: featureFlagKeySchema,
  description: z.string(),
  defaultEnabled: z.boolean(),
  override: z.boolean().nullable(),
  enabled: z.boolean(),
});

export type FeatureFlagStatus = z.infer<typeof featureFlagStatusSchema>;

export type FeatureFlagsCommands = {
  getFlag(key: FeatureFlagKey): Promise<FeatureFlagStatus>;
  listFlags(): Promise<FeatureFlagStatus[]>;
  setFlag(input: { key: FeatureFlagKey; override: boolean | null }): Promise<FeatureFlagStatus>;
};
