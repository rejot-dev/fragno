import { useState, useCallback, useMemo } from "react";

/**
 * Hook to track whether a field has been touched and should show errors.
 *
 * Errors should be shown if:
 * - The field has been touched (user changed the value at least once)
 * - OR the field has a value (handles pre-filled/auto-filled forms)
 *
 * @param data - The current field value
 * @returns showErrors - Whether to display validation errors
 * @returns markTouched - Callback to mark the field as touched
 */
export function useTouched<T>(data: T) {
  const [touched, setTouched] = useState(false);

  // Show errors if touched OR if data has a value
  const showErrors = useMemo(() => {
    if (touched) {
      return true;
    }
    if (data === undefined || data === null || data === "") {
      return false;
    }
    return true;
  }, [touched, data]);

  const markTouched = useCallback(() => {
    setTouched(true);
  }, []);

  return { showErrors, markTouched };
}
