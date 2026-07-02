import type { LofiMutation } from "../types";

type DbNowLike = {
  tag: "db-now";
  offsetMs?: number;
};

const isDbNowLike = (value: unknown): value is DbNowLike =>
  typeof value === "object" && value !== null && (value as { tag?: string }).tag === "db-now";

const resolveMutationValue = (value: unknown, baseNow: number): unknown => {
  if (isDbNowLike(value)) {
    return new Date(baseNow + (value.offsetMs ?? 0));
  }
  return value;
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
