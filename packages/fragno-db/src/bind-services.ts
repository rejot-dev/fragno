import { serviceContext } from "./fragment";

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

export function bindServicesToContext<T extends Record<string, unknown>>(
  services: T,
): BoundServices<T> {
  const bound = {} as BoundServices<T>;

  for (const [key, value] of Object.entries(services)) {
    if (typeof value === "function") {
      // Bind function to serviceContext
      bound[key as keyof T] = value.bind(serviceContext) as BoundServices<T>[keyof T];
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively bind nested service objects
      bound[key as keyof T] = bindServicesToContext(
        value as Record<string, unknown>,
      ) as BoundServices<T>[keyof T];
    } else {
      bound[key as keyof T] = value as BoundServices<T>[keyof T];
    }
  }

  return bound;
}
