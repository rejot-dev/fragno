import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { z } from "zod";

/**
 * A value the code defaults and administrators override for scopes. The most specific override on
 * a scope's chain decides: a project's, then its app's, then its organization's or user's, then
 * the system's.
 */
export type OverrideDefinition<TSchema extends z.ZodType = z.ZodType> = {
  description: string;
  schema: TSchema;
  default: z.output<TSchema>;
  /** The kinds of scope an override may be set on. */
  scopes: readonly BackofficeContextScope["kind"][];
};

export type OverrideDefinitions = Record<string, OverrideDefinition>;

/** Feature flags roll code out and are removed once it ships; entitlements are what an account may do. */
export type OverrideKind = "feature-flag" | "entitlement";

/** An override as the store keeps it: its scope named by path segment, its value as set. */
export type StoredOverride = { scope: string; kind: OverrideKind; key: string; value: unknown };

export type OverridesCommands = {
  /** The overrides this object keeps for a scope and the scopes that own it. */
  listOverrides(scope: BackofficeContextScope): Promise<StoredOverride[]>;
  /** Sets an override on a scope this object keeps. */
  setOverride(input: OverrideAddress & { value: unknown }): Promise<void>;
  clearOverride(input: OverrideAddress): Promise<void>;
};

export type OverrideAddress = { scope: BackofficeContextScope; kind: OverrideKind; key: string };
