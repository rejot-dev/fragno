import type { ShouldRevalidateFunctionArgs } from "react-router";

/**
 * For a route whose loader reads only its scope: navigating within the scope keeps the loaded
 * data, while switching scopes and submitting forms load it again.
 */
export function shouldRevalidateWithinScope({
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  const sameScope =
    currentParams.scopeKind === nextParams.scopeKind &&
    currentParams.scopeId === nextParams.scopeId;
  return sameScope && formMethod === undefined ? false : defaultShouldRevalidate;
}
