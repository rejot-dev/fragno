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
  type FragmentInstantiationBuilder,
  type FragnoInstantiatedFragment,
  type AnyFragnoInstantiatedFragment,
  type BoundServices,
  type InstantiatedFragmentFromDefinition,
  type FragnoExecutionContext,
  type FragnoRequestLifecycleContext,
} from "./api/fragment-instantiator";
export type { RequestPropagationContext } from "./api/request-context-storage";

// ============================================================================
// Core Configuration
// ============================================================================
export type { FragnoPublicConfig } from "./api/shared-types";

// ============================================================================
// Runtime
// ============================================================================
export { defaultFragnoRuntime, type FragnoRuntime } from "./runtime";
export { createId, init } from "./id";

// ============================================================================
// Route Definition
// ============================================================================
export {
  defineRoute,
  defineRoutes,
  type AnyRouteOrFactory,
  type RouteFactory,
  type RouteFactoryContext,
} from "./api/route";

export { type FragnoRouteConfig, type RequestThisContext, type RouteContentType } from "./api/api";
