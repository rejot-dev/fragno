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
 * Bind all functions in a service object to a specific context.
 * This allows services to use `this` to access the context.
 *
 * @param services - The service object to bind
 * @param context - The context to bind to (e.g., { getUnitOfWork })
 * @returns A new object with all functions bound to the context
 */
export function bindServicesToContext<T extends object, TContext extends object>(
  services: T,
  context: TContext,
): BoundServices<T> {
  const bound = {} as BoundServices<T>;

  for (const [key, value] of Object.entries(services)) {
    if (typeof value === "function") {
      // Bind function to the provided context
      bound[key as keyof T] = value.bind(context) as BoundServices<T>[keyof T];
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively bind nested service objects
      bound[key as keyof T] = bindServicesToContext(value, context) as BoundServices<T>[keyof T];
    } else {
      bound[key as keyof T] = value as BoundServices<T>[keyof T];
    }
  }

  return bound;
}
