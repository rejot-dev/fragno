import {
  backofficeScopeOrganization,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { PostHog } from "posthog-node";

import type {
  BackofficeTelemetry,
  BackofficeTelemetryObject,
  BackofficeTelemetrySignal,
} from "@/backoffice-runtime/backoffice-telemetry";

import { createCloudflarePostHog, shutdownCloudflarePostHog } from "./cloudflare-posthog";

type CloudflarePostHogTelemetryEnv = Pick<
  CloudflareEnv,
  "POSTHOG_PROJECT_TOKEN" | "POSTHOG_HOST" | "CF_VERSION_METADATA"
>;

/**
 * Sends an object's signals to PostHog. Signals recorded while a client starts join its batch, so
 * the signals of one invocation usually share one delivery.
 */
export function createCloudflarePostHogTelemetry(
  env: CloudflarePostHogTelemetryEnv,
  state: Pick<DurableObjectState, "waitUntil">,
): BackofficeTelemetry {
  let batch: BackofficeTelemetrySignal[] | null = null;

  async function deliver(signals: BackofficeTelemetrySignal[]) {
    const client = await createCloudflarePostHog(env);
    batch = null;
    if (!client) {
      return;
    }
    for (const signal of signals) {
      try {
        sendSignal(client, env, signal);
      } catch {
        console.warn("PostHog telemetry capture failed.");
      }
    }
    await shutdownCloudflarePostHog(client);
  }

  return {
    record(signal) {
      if (batch) {
        batch.push(signal);
        return;
      }
      const signals = [signal];
      batch = signals;
      state.waitUntil(deliver(signals));
    },
  };
}

function sendSignal(
  client: PostHog,
  env: CloudflarePostHogTelemetryEnv,
  signal: BackofficeTelemetrySignal,
) {
  const { attempt, outcome } = signal;
  const object = objectProperties(signal.object);
  client.metrics.count("durable_hook.attempts", 1, {
    attributes: {
      object: object.object,
      scope_kind: object.scope_kind,
      hook_namespace: attempt.namespace,
      hook_name: attempt.hookName,
      outcome: outcome.status,
    },
  });
  if (outcome.status !== "failed") {
    return;
  }
  const errorName = outcome.error instanceof Error ? outcome.error.name : "UnknownError";
  client.captureException(outcome.error, `object:${object.scope ?? object.object}`, {
    ...object,
    source: "cloudflare-object",
    release: env.CF_VERSION_METADATA.id,
    hook_namespace: attempt.namespace,
    hook_name: attempt.hookName,
    hook_id: attempt.hookId.toString(),
    hook_correlation_id: attempt.idempotencyKey,
    attempt: attempt.attempt,
    max_attempts: attempt.maxAttempts,
    // Without source maps, PostHog groups by message, which carries per-hook ids.
    $exception_fingerprint: `durable-hook:${attempt.namespace}:${attempt.hookName}:${errorName}`,
    $process_person_profile: false,
  });
}

function objectProperties({ host, scope }: BackofficeTelemetryObject) {
  if (scope === null) {
    return { object: host, scope: null, scope_kind: "unaddressed", organization_id: null };
  }
  switch (scope.kind) {
    case "singleton":
      return { object: host, scope: "system", scope_kind: "system", organization_id: null };
    case "named":
      return {
        object: host,
        scope: `named:${scope.name}`,
        scope_kind: "named",
        organization_id: null,
      };
    case "org":
    case "user":
    case "app":
    case "project":
      return {
        object: host,
        scope: backofficeScopePathSegment(scope),
        scope_kind: scope.kind,
        organization_id: backofficeScopeOrganization(scope)?.orgId ?? null,
      };
    default:
      throw new Error("Unsupported Backoffice object scope kind.", {
        cause: scope satisfies never,
      });
  }
}
