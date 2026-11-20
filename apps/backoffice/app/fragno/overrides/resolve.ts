import {
  type BackofficeContextScope,
  type BackofficeScope,
  type BackofficeScopeNames,
  backofficeScopePathSegment,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { OverrideDefinition, OverrideKind, StoredOverride } from "./definition";

/** A value in a scope, and the overrides on the scope's chain that decide it. */
export type OverrideStatus<TValue = unknown> = {
  key: string;
  description: string;
  default: TValue;
  value: TValue;
  /** Most specific first; the first decides, and the default applies when there are none. */
  overrides: { scope: BackofficeContextScope; value: TValue }[];
};

/**
 * A scope and the scopes that own it, most specific first. Every chain ends in the system scope,
 * so an override there applies wherever nothing more specific overrides it.
 */
export function overrideScopeChain<TNames extends BackofficeScopeNames>(
  scope: BackofficeScope<TNames>,
): BackofficeScope<TNames>[] {
  switch (scope.kind) {
    case "system":
      return [scope];
    case "org":
    case "user":
      return [scope, { kind: "system" }];
    case "app":
    case "project":
      return [scope, ...overrideScopeChain<TNames>(scope.owner)];
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
}

/**
 * The scope whose object keeps a scope's overrides: its root owner, so they stay in the owner's
 * jurisdiction, or the system for system overrides.
 */
export function overrideStoreScope(scope: BackofficeContextScope): BackofficeContextScope {
  return backofficeScopeRootOwner(scope) ?? { kind: "system" };
}

export function resolveOverride<TDefinition extends OverrideDefinition>(
  { kind, key, definition }: { kind: OverrideKind; key: string; definition: TDefinition },
  scope: BackofficeContextScope,
  stored: StoredOverride[],
): OverrideStatus<TDefinition["default"]> {
  const chainOverrides = overrideScopeChain(scope).flatMap((chainScope) => {
    if (!definition.scopes.includes(chainScope.kind)) {
      return [];
    }
    const segment = backofficeScopePathSegment(chainScope);
    const override = stored.find(
      (entry) => entry.kind === kind && entry.key === key && entry.scope === segment,
    );
    if (!override) {
      return [];
    }
    // Skipping a value the definition has since stopped accepting would let a broader override
    // above it decide, such as a system grant replacing a person's restriction.
    const parsed = definition.schema.safeParse(override.value);
    if (!parsed.success) {
      throw new Error(
        `The ${kind} ${key} on ${segment} holds ${JSON.stringify(override.value)}, which it no longer accepts. Set or clear that override.`,
      );
    }
    return [{ scope: chainScope, value: parsed.data }];
  });
  return {
    key,
    description: definition.description,
    default: definition.default,
    value: chainOverrides.length > 0 ? chainOverrides[0].value : definition.default,
    overrides: chainOverrides,
  };
}
