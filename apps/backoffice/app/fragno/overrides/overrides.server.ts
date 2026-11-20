import {
  type BackofficeContextScope,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { entitlementDefinitions } from "@/fragno/entitlements/definitions";
import { featureFlagDefinitions } from "@/fragno/feature-flags/definitions";

import type {
  OverrideAddress,
  OverrideDefinition,
  OverrideDefinitions,
  OverrideKind,
  StoredOverride,
} from "./definition";
import { overrideStoreScope, resolveOverride, type OverrideStatus } from "./resolve";

type OverridesRuntime = Pick<BackofficeRuntimeServices, "config" | "objects">;

const definitionsByKind: Record<OverrideKind, OverrideDefinitions> = {
  "feature-flag": featureFlagDefinitions,
  entitlement: entitlementDefinitions,
};

export async function overrideInScope(
  runtime: OverridesRuntime,
  { kind, key, scope }: OverrideAddress,
): Promise<OverrideStatus> {
  const definition = requireDefinition(kind, key);
  return resolveOverride(
    { kind, key, definition },
    scope,
    await storedOverridesInScope(runtime, scope),
  );
}

export async function overridesInScope(
  runtime: OverridesRuntime,
  kind: OverrideKind,
  scope: BackofficeContextScope,
): Promise<OverrideStatus[]> {
  const stored = await storedOverridesInScope(runtime, scope);
  return Object.entries(definitionsByKind[kind]).map(([key, definition]) =>
    resolveOverride({ kind, key, definition }, scope, stored),
  );
}

/** Sets an override on exactly this scope, once its definition accepts the scope and value. */
export async function setOverrideInScope(
  runtime: OverridesRuntime,
  input: OverrideAddress & { value: unknown },
): Promise<void> {
  const definition = requireDefinition(input.kind, input.key);
  if (!definition.scopes.includes(input.scope.kind)) {
    throw new BackofficeOperationError(
      "invalid_request",
      `${input.key} can only be overridden on ${definition.scopes.join(", ")} scopes.`,
    );
  }
  const parsed = definition.schema.safeParse(input.value);
  if (!parsed.success) {
    throw new BackofficeOperationError(
      "invalid_request",
      `${JSON.stringify(input.value)} is not a value ${input.key} accepts: ${parsed.error.message}`,
    );
  }
  await storeFor(runtime, input.scope).setOverride({ ...input, value: parsed.data });
}

export async function clearOverrideInScope(
  runtime: OverridesRuntime,
  input: OverrideAddress,
): Promise<void> {
  requireDefinition(input.kind, input.key);
  await storeFor(runtime, input.scope).clearOverride(input);
}

function requireDefinition(kind: OverrideKind, key: string): OverrideDefinition {
  if (!Object.hasOwn(definitionsByKind[kind], key)) {
    throw new BackofficeOperationError("invalid_request", `There is no ${kind} named ${key}.`);
  }
  return definitionsByKind[kind][key];
}

function storeFor(runtime: OverridesRuntime, scope: BackofficeContextScope) {
  if (!runtime.config.bindings.overrides) {
    throw new Error("Overrides require the OVERRIDES binding.");
  }
  return runtime.objects.overrides.for(overrideStoreScope(scope)).commands;
}

/** The stored overrides on a scope's chain, which live with its root owner, except the system's own. */
export async function storedOverridesInScope(
  runtime: OverridesRuntime,
  scope: BackofficeContextScope,
): Promise<StoredOverride[]> {
  // Without the binding nothing can be overridden, so every value keeps its default.
  if (!runtime.config.bindings.overrides) {
    return [];
  }
  const rootOwner = backofficeScopeRootOwner(scope);
  const stores: BackofficeContextScope[] = rootOwner
    ? [rootOwner, { kind: "system" }]
    : [{ kind: "system" }];
  const lists = await Promise.all(
    stores.map((store) => runtime.objects.overrides.for(store).commands.listOverrides(scope)),
  );
  return lists.flat();
}
