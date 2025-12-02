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

import type {
  IFragmentInstantiationBuilder,
  IFragnoInstantiatedFragment,
} from "./api/fragment-instantiator";
import { instantiatedFragmentFakeSymbol } from "./internal/symbols";

// Stub implementation for defineFragment
// This is stripped by unplugin-fragno in browser builds
export function defineFragment(_name: string) {
  const definitionStub = {
    name: _name,
  };

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
    build: () => definitionStub,
  };
  return stub;
}

// Re-export the builder class (for type compatibility)
export { FragmentDefinitionBuilder } from "./api/fragment-definition-builder";

// Stub implementation for instantiate
// This is stripped by unplugin-fragno in browser builds
export function instantiate(_definition: unknown) {
  const fragmentStub: IFragnoInstantiatedFragment = {
    [instantiatedFragmentFakeSymbol]: instantiatedFragmentFakeSymbol,
    name: "",
    routes: [],
    services: {},
    mountRoute: "",
    $internal: {
      deps: {},
      options: {},
      linkedFragments: {},
    },
    withMiddleware: () => {
      // throw new Error("withMiddleware is not supported in browser builds");
      return fragmentStub;
    },
    inContext: <T>(callback: () => T) => callback(),
    handlersFor: () => ({}),
    handler: async () => new Response(),
    callRoute: async () => ({ ok: true, data: undefined, error: undefined }),
    callRouteRaw: async () => new Response(),
  };

  const builderStub: IFragmentInstantiationBuilder = {
    withConfig: () => builderStub,
    withRoutes: () => builderStub,
    withOptions: () => builderStub,
    withServices: () => builderStub,
    build: () => fragmentStub,
    definition: {},
    routes: [],
    config: undefined,
    options: undefined,
  };

  return builderStub;
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
