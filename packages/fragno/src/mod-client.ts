// ============================================================================
// Client-side entry point for @fragno-dev/core
// This file mirrors mod.ts but provides stub implementations for server-side
// APIs that are stripped by unplugin-fragno during browser builds.
// ============================================================================

// ============================================================================
// Fragment Definition and Instantiation
// ============================================================================

// Re-export types only
export type {
  FragmentDefinition,
  ServiceContext,
  ServiceConstructorFn,
} from "./api/fragment-definition-builder";

export type {
  FragmentInstantiationBuilder,
  FragnoInstantiatedFragment,
  BoundServices,
} from "./api/fragment-instantiator";

// Stub implementation for defineFragment
// This is stripped by unplugin-fragno in browser builds
export function defineFragment(_name: string) {
  const stub = {
    withDependencies: () => stub,
    providesBaseService: () => stub,
    providesService: () => stub,
    providesPrivateService: () => stub,
    usesService: () => stub,
    usesOptionalService: () => stub,
    withRequestStorage: () => stub,
    withExternalRequestStorage: () => stub,
    withThisContext: () => stub,
    withLinkedFragment: () => stub,
    extend: () => stub,
    build: () => ({}),
  };
  return stub;
}

// Re-export the builder class (for type compatibility)
export { FragmentDefinitionBuilder } from "./api/fragment-definition-builder";

// Stub implementation for instantiate
// This is stripped by unplugin-fragno in browser builds
export function instantiate(_definition: unknown) {
  const stub = {
    withConfig: () => stub,
    withRoutes: () => stub,
    withOptions: () => stub,
    withServices: () => stub,
    build: () => ({}),
    definition: {},
    routes: [],
    config: undefined,
    options: undefined,
  };
  return stub;
}

// ============================================================================
// Core Configuration
// ============================================================================
export type { FragnoPublicConfig } from "./api/shared-types";

// ============================================================================
// Route Definition
// ============================================================================
export {
  defineRoute,
  defineRoutes,
  type RouteFactory,
  type RouteFactoryContext,
} from "./api/route";

export type { FragnoRouteConfig, RequestThisContext } from "./api/api";

export { instantiatedFragmentFakeSymbol } from "./internal/symbols";
