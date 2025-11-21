// ============================================================================
// Fragment Definition and Instantiation
// ============================================================================
export {
  defineFragment,
  FragmentDefinitionBuilder,
  type FragmentDefinition,
  type ServiceContext,
  type ServiceConstructorFn,
  type LinkedFragmentCallback,
} from "./api/fragment-definition-builder";

export {
  instantiate,
  type FragmentInstantiationBuilder,
  type FragnoInstantiatedFragment,
  type BoundServices,
} from "./api/fragment-instantiator";

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

export { type FragnoRouteConfig, type RequestThisContext } from "./api/api";
