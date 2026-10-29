import type { PostHog } from "posthog-node";

import {
  backofficeScopeFields,
  type BackofficeTelemetry,
  type BackofficeTelemetryObject,
  type BackofficeTelemetrySignal,
} from "@/backoffice-runtime/backoffice-telemetry";
import { formatUsageQuantity } from "@/fragno/billing/usage-limits";

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
    let client: PostHog | null;
    try {
      client = await createCloudflarePostHog(env);
    } finally {
      batch = null;
    }
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
  const object = objectProperties(signal.object);
  // Metric attributes stay low-cardinality: each combination is its own series.
  const series = { object: object.object, scope_kind: object.scope_kind };
  const distinctId = `object:${object.scope ?? object.object}`;
  const envelope = {
    ...object,
    ...(object.organization_id === null
      ? {}
      : { $groups: { organization: object.organization_id } }),
    source: "cloudflare-object",
    release: env.CF_VERSION_METADATA.id,
    $process_person_profile: false,
  };

  switch (signal.kind) {
    case "durable-hook-attempt": {
      const { attempt, outcome } = signal;
      client.metrics.count("durable_hook.attempts", 1, {
        attributes: {
          ...series,
          hook_namespace: attempt.namespace,
          hook_name: attempt.hookName,
          outcome: outcome.status,
        },
      });
      if (outcome.status !== "failed") {
        return;
      }
      client.captureException(outcome.error, distinctId, {
        ...envelope,
        hook_namespace: attempt.namespace,
        hook_name: attempt.hookName,
        hook_id: attempt.hookId.toString(),
        hook_correlation_id: attempt.idempotencyKey,
        attempt: attempt.attempt,
        max_attempts: attempt.maxAttempts,
        // Without source maps, PostHog groups by message, which carries per-hook ids.
        $exception_fingerprint: `durable-hook:${attempt.namespace}:${attempt.hookName}:${errorName(outcome.error)}`,
      });
      return;
    }
    case "durable-hooks-lost-alarm":
      client.capture({
        distinctId,
        event: "durable_hooks_lost_alarm",
        properties: {
          ...envelope,
          lost_alarm_scheduled_at: signal.alarm.scheduledAt.toISOString(),
        },
      });
      return;
    case "durable-hooks-stuck-requeued":
      client.capture({
        distinctId,
        event: "durable_hooks_stuck_requeued",
        properties: {
          ...envelope,
          hook_namespace: signal.stuck.namespace,
          hook_names: [...new Set(signal.stuck.events.map((event) => event.hookName))],
          hook_count: signal.stuck.events.length,
          stuck_timeout_minutes: signal.stuck.timeoutMinutes,
        },
      });
      return;
    case "host-error":
      client.metrics.count("object.host_errors", 1, {
        attributes: { ...series, stage: signal.stage },
      });
      client.captureException(signal.error, distinctId, {
        ...envelope,
        host_error_stage: signal.stage,
        $exception_fingerprint: `host-error:${object.object}:${signal.stage}:${errorName(signal.error)}`,
      });
      return;
    case "workflow-finished": {
      const { outcome } = signal;
      client.metrics.count("workflow.instances.finished", 1, {
        attributes: { ...series, workflow_name: signal.workflowName, status: outcome.status },
      });
      const workflow = {
        ...envelope,
        workflow_name: signal.workflowName,
        workflow_program: signal.program,
        workflow_instance_id: signal.instanceId,
        workflow_run_generation: signal.runGeneration,
        status: outcome.status,
      };
      client.capture({ distinctId, event: "workflow_instance_finished", properties: workflow });
      if (outcome.status === "errored") {
        captureRecordedException(client, distinctId, outcome.error, {
          ...workflow,
          // A workflow we ship is one failure everywhere; a script is its scope's own code.
          $exception_fingerprint:
            signal.program === null
              ? `workflow:${signal.workflowName}:${outcome.error.name}`
              : `workflow:${signal.workflowName}:${object.scope}:${signal.program}:${outcome.error.name}`,
        });
      }
      return;
    }
    case "codemode-run-finished": {
      const { outcome } = signal;
      const attributes = {
        ...series,
        activation: signal.activationKind,
        status: outcome.status,
      };
      client.metrics.count("codemode.runs.finished", 1, { attributes });
      client.metrics.histogram("codemode.run.duration", signal.durationMs, {
        unit: "ms",
        attributes,
      });
      // A failed workflow tick is reported with its workflow once the workflow errors.
      if (outcome.status !== "failed" || signal.activationKind === "workflow") {
        return;
      }
      captureRecordedException(client, distinctId, outcome.error, {
        ...envelope,
        codemode_run_id: signal.runId,
        codemode_origin: signal.origin.kind === "file" ? signal.origin.path : "inline",
        codemode_activation: signal.activationKind,
        codemode_error_kind: outcome.error.kind,
        duration_ms: signal.durationMs,
        // Inline code has no identity to group by, so PostHog groups it by error name and message.
        ...(signal.origin.kind === "file"
          ? {
              $exception_fingerprint: `codemode:${object.scope}:${signal.origin.path}:${outcome.error.kind}:${outcome.error.name}`,
            }
          : {}),
      });
      return;
    }
    case "access-code-redeemed":
      client.capture({
        distinctId,
        event: "access_code_redeemed",
        properties: {
          ...envelope,
          access_code_id: signal.accessCodeId,
          access_code_label: signal.accessCodeLabel,
        },
      });
      return;
    case "usage-limit-reached": {
      const { status } = signal;
      client.capture({
        distinctId,
        event: "usage_limit_reached",
        properties: {
          ...envelope,
          period: signal.period,
          meter: status.meter,
          unit: status.unit,
          limit_setting: status.setting,
          limit_quantity: status.limit.quantity,
          used_quantity: status.used,
          limit_display: formatUsageQuantity(status.meter, status.limit.quantity),
          used_display: formatUsageQuantity(status.meter, status.used),
        },
      });
      return;
    }
    default:
      throw new Error("Unsupported Backoffice telemetry signal.", {
        cause: signal satisfies never,
      });
  }
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Captures an error that was stored without its stack. `captureException` would attach a stack from
 * this reporter, which PostHog groups by, so the exception is sent as it was recorded: frameless.
 */
function captureRecordedException(
  client: PostHog,
  distinctId: string,
  error: { name: string; message: string },
  properties: Record<string, unknown>,
) {
  client.capture({
    distinctId,
    event: "$exception",
    properties: {
      ...properties,
      $exception_list: [
        {
          type: error.name,
          value: error.message,
          mechanism: { type: "generic", handled: true, synthetic: false, exception_id: 0 },
        },
      ],
      $exception_level: "error",
    },
    // The exception list above is the metadata whose absence this flag's warning is about.
    _originatedFromCaptureException: true,
  });
}

function objectProperties({ host, scope }: BackofficeTelemetryObject) {
  const fields = backofficeScopeFields(scope);
  return {
    object: host,
    scope: fields.scope,
    scope_kind: fields.scopeKind,
    organization_id: fields.orgId,
  };
}
