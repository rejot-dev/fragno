import type { LofiMutation } from "../types";

type DbNowLike = {
  tag: "db-now";
  offsetMs?: number;
};

const isDbNowLike = (value: unknown): value is DbNowLike =>
  typeof value === "object" && (value as { tag?: string })?.tag === "db-now";

const resolveMutationValue = (value: unknown, baseNow: number): unknown => {
  if (isDbNowLike(value)) {
    return new Date(baseNow + (value.offsetMs ?? 0));
  }
  return value;
};

export const assertNoUnresolvedDbNowMutations = (mutations: readonly LofiMutation[]): void => {
  for (const mutation of mutations) {
    if (mutation.op === "delete") {
      continue;
    }

    const values = mutation.op === "create" ? mutation.values : mutation.set;
    for (const [field, value] of Object.entries(values)) {
      if (isDbNowLike(value)) {
        throw new Error(
          `Outbox mutation ${mutation.schema}.${mutation.table}.${field} contains unresolved DbNow.`,
        );
      }
    }
  }
};

export const resolveMutationValues = (
  values: Record<string, unknown>,
  baseNow = Date.now(),
): Record<string, unknown> => {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = resolveMutationValue(value, baseNow);
  }
  return resolved;
};

export const resolveMutation = (mutation: LofiMutation, baseNow = Date.now()): LofiMutation => {
  if (mutation.op === "create") {
    return { ...mutation, values: resolveMutationValues(mutation.values, baseNow) };
  }
  if (mutation.op === "update") {
    return { ...mutation, set: resolveMutationValues(mutation.set, baseNow) };
  }
  return mutation;
};

export const resolveMutations = (
  mutations: readonly LofiMutation[],
  baseNow = Date.now(),
): LofiMutation[] => mutations.map((mutation) => resolveMutation(mutation, baseNow));
