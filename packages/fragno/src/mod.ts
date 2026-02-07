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
  type LinkedFragmentParentMeta,
  type ExtractLinkedServices,
} from "./api/fragment-definition-builder";

export {
  instantiate,
  type FragmentInstantiationBuilder,
  type FragnoInstantiatedFragment,
  type AnyFragnoInstantiatedFragment,
  type BoundServices,
  type InstantiatedFragmentFromDefinition,
} from "./api/fragment-instantiator";

// ============================================================================
// Core Configuration
// ============================================================================
export type { FragnoPublicConfig } from "./api/shared-types";

// ============================================================================
// Runtime
// ============================================================================
export { defaultFragnoRuntime, type FragnoRuntime } from "./runtime";

// ============================================================================
// Route Definition
// ============================================================================
export {
  defineRoute,
  defineRoutes,
  type RouteFactory,
  type RouteFactoryContext,
} from "./api/route";

export { type FragnoRouteConfig, type RequestThisContext, type RouteContentType } from "./api/api";
