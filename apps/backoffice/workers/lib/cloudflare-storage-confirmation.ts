import type { BackofficeScopeFields } from "@/backoffice-runtime/backoffice-telemetry";
import type { BackofficeStorageConfirmation } from "@/backoffice-runtime/runtime-instrumentation";

/**
 * Logs how long Cloudflare takes to make this object's writes so far durable.
 *
 * The output gate holds every outgoing message, including RPC calls, responses, and alarm
 * completion, until earlier writes are durable, so slow confirmation shows up as a stall with no
 * CPU and no spans. Observing it does not wait, so callers keep the latency they would have had.
 */
export function observeCloudflareStorageConfirmation(
  storage: DurableObjectStorage,
  scope: BackofficeScopeFields,
  confirmation: BackofficeStorageConfirmation,
): void {
  const startedAt = performance.now();
  const log = (outcome: "confirmed" | "failed") => {
    console.info("backoffice.storage_confirmation.finished", {
      ...confirmation,
      ...scope,
      outcome,
      confirmationDurationMs: performance.now() - startedAt,
    });
  };
  // A failed write resets the object and fails its pending work; this observer only reports it.
  storage.sync().then(
    () => {
      log("confirmed");
    },
    () => {
      log("failed");
    },
  );
}
