import { useEffect, useRef } from "react";

import type { FormResult } from "./books.server";

/** The refusal of the form submitted with `intent`, under that form. */
export function FormError({ result, intent }: { result: FormResult | undefined; intent: string }) {
  if (result?.intent !== intent || result.error === null) {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-[var(--bo-failed)]">
      {result.error}
    </p>
  );
}

/**
 * A ref for the form submitted with `intent` that empties it once its submission succeeds, so the
 * next record starts blank; a refused submission keeps what was typed.
 */
export function useFormReset(result: FormResult | undefined, intent: string) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (result?.intent === intent && result.error === null) {
      form.current?.reset();
    }
  }, [result, intent]);
  return form;
}
