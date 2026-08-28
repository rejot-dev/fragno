import type {
  FragmentDurableObjectInitializationContext,
  FragmentDurableObjectInitializationInstrumentation,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { tracing } from "cloudflare:workers";

function initializationSpanName(context: FragmentDurableObjectInitializationContext): string {
  return context.phase === "createRuntime"
    ? "fragno.fragment_runtime.create"
    : "fragno.fragment.migrate";
}

function runCloudflareFragmentInitializationSpan<T>(
  context: FragmentDurableObjectInitializationContext,
  execute: () => T,
): T {
  let enteredSpan = false;
  try {
    const result = tracing.enterSpan(initializationSpanName(context), (span) => {
      enteredSpan = true;
      span.setAttribute("fragno.runtime.host.name", context.hostName);
      span.setAttribute("fragno.runtime.initialization.phase", context.phase);
      if (context.phase === "migrate") {
        span.setAttribute("fragno.db.fragment.name", context.fragmentName);
      }
      return execute();
    });

    if (enteredSpan) {
      return result;
    }
  } catch (error) {
    if (enteredSpan) {
      throw error;
    }
  }

  return execute();
}

/** Creates stable Cloudflare spans at the Fragno runtime creation and migration boundaries. */
export const cloudflareFragmentInitializationInstrumentation: FragmentDurableObjectInitializationInstrumentation =
  {
    run: runCloudflareFragmentInitializationSpan,
  };
