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
  return {
    withDependencies: () => ({ withDependencies: () => ({}) }),
    providesBaseService: () => ({ providesBaseService: () => ({}) }),
    providesService: () => ({ providesService: () => ({}) }),
    withRequestStorage: () => ({ withRequestStorage: () => ({}) }),
    withExternalRequestStorage: () => ({ withExternalRequestStorage: () => ({}) }),
    withRequestThisContext: () => ({ withRequestThisContext: () => ({}) }),
    extend: () => ({ extend: () => ({}) }),
    build: () => ({}),
  };
}

// Re-export the builder class (for type compatibility)
export { FragmentDefinitionBuilder } from "./api/fragment-definition-builder";

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
