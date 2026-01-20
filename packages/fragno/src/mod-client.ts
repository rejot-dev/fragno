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
  InstantiatedFragmentFromDefinition,
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

  const stubMethods = {
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
    // From fragno-db
    provideHooks: () => stub,
  };

  // Wrap with Proxy to handle any additional methods (e.g. from extend())
  const stub: object = new Proxy(stubMethods, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof typeof target];
      }
      // Return a function that returns the stub for method chaining
      return () => stub;
    },
  });

  return stub;
}

// Re-export the builder class (for type compatibility)
export { FragmentDefinitionBuilder } from "./api/fragment-definition-builder";

// Stub implementation for instantiate
// This is stripped by unplugin-fragno in browser builds
export function instantiate(_definition: unknown) {
  const fragmentStubMethods = {
    [instantiatedFragmentFakeSymbol]: instantiatedFragmentFakeSymbol,
    name: "",
    routes: [],
    services: {},
    mountRoute: "",
    get $internal() {
      return {
        deps: {},
        options: {},
        linkedFragments: {},
      };
    },
    withMiddleware: () => fragmentStub,
    inContext: <T>(callback: () => T) => callback(),
    handlersFor: () => ({}),
    handler: async () => new Response(),
    callRoute: async () => ({ ok: true, data: undefined, error: undefined }),
    callRouteRaw: async () => new Response(),
  };

  // Wrap with Proxy to handle any additional methods
  const fragmentStub: IFragnoInstantiatedFragment = new Proxy(
    fragmentStubMethods as IFragnoInstantiatedFragment,
    {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        // Return a function that returns the stub for method chaining
        return () => fragmentStub;
      },
    },
  );

  const builderStubMethods = {
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

  // Wrap with Proxy to handle any additional methods
  const builderStub: IFragmentInstantiationBuilder = new Proxy(
    builderStubMethods as IFragmentInstantiationBuilder,
    {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        // Return a function that returns the stub for method chaining
        return () => builderStub;
      },
    },
  );

  return builderStub;
}

// ============================================================================
// Core Configuration
// ============================================================================
export type { FragnoDispatcher, FragnoPublicConfig } from "./api/shared-types";

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
