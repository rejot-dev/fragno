/**
 * Forces TypeScript to simplify/flatten complex intersection types for better display in IDE hovers
 */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
