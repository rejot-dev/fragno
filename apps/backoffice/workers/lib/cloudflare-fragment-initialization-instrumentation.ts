import type {
  FragmentDurableObjectInitializationContext,
  FragmentDurableObjectInitializationInstrumentation,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { tracing } from "cloudflare:workers";

import {
  backofficeScopeSpanAttributes,
  type BackofficeScopeFields,
} from "@/backoffice-runtime/backoffice-telemetry";
import { backofficeFragmentInitializationSpanName } from "@/backoffice-runtime/runtime-instrumentation";

function runCloudflareFragmentInitializationSpan<T>(
  scope: BackofficeScopeFields,
  context: FragmentDurableObjectInitializationContext,
  execute: () => T,
): T {
  let enteredSpan = false;
  try {
    const result = tracing.enterSpan(backofficeFragmentInitializationSpanName(context), (span) => {
      enteredSpan = true;
      span.setAttributes(backofficeScopeSpanAttributes(scope));
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

/** Creates stable Cloudflare spans at one object's runtime creation and migration boundaries. */
export function createCloudflareFragmentInitializationInstrumentation(
  scope: BackofficeScopeFields,
): FragmentDurableObjectInitializationInstrumentation {
  return {
    run: (context, execute) => runCloudflareFragmentInitializationSpan(scope, context, execute),
  };
}
