import type { RequestThisContext } from "@fragno-dev/core/api";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IUnitOfWorkBase, UnitOfWorkSchemaView } from "./query/unit-of-work";
import type { AnySchema } from "./schema/create";

// AsyncLocalStorage for Unit of Work (used by old fragment system)
export const uowStorage = new AsyncLocalStorage<IUnitOfWorkBase>();

/**
 * Service context for database fragments, providing access to the Unit of Work.
 * This reads from AsyncLocalStorage and is used by the old fragment system.
 */
export interface DatabaseRequestThisContext extends RequestThisContext {
  getUnitOfWork(): IUnitOfWorkBase;
  getUnitOfWork<TSchema extends AnySchema>(schema: TSchema): UnitOfWorkSchemaView<TSchema>;
}

/**
 * Implementation function for getUnitOfWork
 */
function getUnitOfWorkImpl(): IUnitOfWorkBase;
function getUnitOfWorkImpl<TSchema extends AnySchema>(
  schema: TSchema,
): UnitOfWorkSchemaView<TSchema>;
function getUnitOfWorkImpl<TSchema extends AnySchema>(
  schema?: TSchema,
): IUnitOfWorkBase | UnitOfWorkSchemaView<TSchema> {
  const uow = uowStorage.getStore();
  if (!uow) {
    throw new Error(
      "No UnitOfWork in context. Service must be called within a route handler OR using `withUnitOfWork`.",
    );
  }
  if (schema) {
    return uow.forSchema(schema);
  }
  return uow;
}

/**
 * Global service context that reads from AsyncLocalStorage.
 * Used by the old fragment system for backward compatibility.
 */
export const serviceContext: DatabaseRequestThisContext = {
  getUnitOfWork: getUnitOfWorkImpl,
};

// Type helper to remove 'this' parameter from functions
type OmitThisParameter<T> = T extends (this: infer _This, ...args: infer A) => infer R
  ? (...args: A) => R
  : T;

// Recursively remove 'this' parameter from all functions in an object
export type BoundServices<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown
    ? OmitThisParameter<T[K]>
    : T[K] extends Record<string, unknown>
      ? BoundServices<T[K]>
      : T[K];
};

/**
 * Bind services to a specific context.
 * If no context is provided, binds to the global serviceContext (for old fragment system).
 * The new NewFragmentDefinition pattern passes an explicit context.
 */
export function bindServicesToContext<T extends Record<string, unknown>>(
  services: T,
  thisContext?: RequestThisContext,
): BoundServices<T> {
  // Default to global serviceContext for backward compatibility
  const context = thisContext ?? serviceContext;
  const bound = {} as BoundServices<T>;

  for (const [key, value] of Object.entries(services)) {
    if (typeof value === "function") {
      // Bind function to context
      bound[key as keyof T] = value.bind(context) as BoundServices<T>[keyof T];
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively bind nested service objects
      bound[key as keyof T] = bindServicesToContext(
        value as Record<string, unknown>,
        context,
      ) as BoundServices<T>[keyof T];
    } else {
      bound[key as keyof T] = value as BoundServices<T>[keyof T];
    }
  }

  return bound;
}
