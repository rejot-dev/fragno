// ============================================================================
// Fragment Definition and Instantiation
// ============================================================================
export {
  defineFragment,
  FragmentDefinitionBuilder,
  type FragmentDefinition,
  type ServiceContext,
  type ServiceConstructorFn,
} from "./api/fragment-definition-builder";

export {
  instantiate,
  type FragmentInstantiationBuilder as NewFragmentInstantiationBuilder,
  type FragnoInstantiatedFragment as NewFragnoInstantiatedFragment,
} from "./api/fragment-instantiator";

// ============================================================================
// Shared types
// ============================================================================
export {
  type FragnoFragmentSharedConfig,
  type FragnoPublicConfig,
  type FragnoPublicClientConfig,
  type FetcherConfig,
} from "./api/shared-types";

export { type FragnoRouteConfig, type RequestThisContext } from "./api/api";

// ============================================================================
// Route Definition
// ============================================================================
export {
  defineRoute,
  defineRoutes,
  type RouteFactory,
  type RouteFactoryContext,
  type AnyRouteOrFactory,
  type FlattenRouteFactories,
} from "./api/route";

export { RequestInputContext } from "./api/request-input-context";
export { RequestOutputContext } from "./api/request-output-context";
