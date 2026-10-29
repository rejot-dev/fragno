import {
  backofficeScopeOrganization,
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { CodemodeWireError } from "@fragno-dev/codemode/execution/codemode-error-contract";
import type { DurableHooksLostAlarm } from "@fragno-dev/db/dispatchers/cloudflare-do";
import type {
  DurableHookAttempt,
  DurableHookAttemptOutcome,
  StuckHookProcessingInfo,
} from "@fragno-dev/db/hooks";
import type { WorkflowTerminalHookPayload } from "@fragno-dev/workflows/workflow";

import type { HookContext } from "@fragno-dev/db";

import type { ExhaustedUsageLimit } from "@/fragno/billing/usage-limits";
import type {
  CodemodeRunFinishedHookPayload,
  CodemodeRunOrigin,
} from "@/fragno/codemode/codemode-fragment";

import type { BackofficeObjectScope } from "./object-registry";

/** The object whose runtime reported a signal. */
export type BackofficeTelemetryObject = {
  /** The hosted Fragment runtime, such as `Automations`. */
  host: string;
  /** Null for objects that no registry address names, such as Pi agents. */
  scope: BackofficeObjectScope | null;
};

/** How monitoring names a scope, in Cloudflare logs and spans as in PostHog. */
export type BackofficeScopeFields = {
  /** The scope's path, such as `org/org-1`; null for objects no registry address names. */
  scope: string | null;
  scopeKind: string;
  orgId: string | null;
};

export function backofficeScopeFields(
  scope: BackofficeObjectScope | BackofficeContextScope | null,
): BackofficeScopeFields {
  if (scope === null) {
    return { scope: null, scopeKind: "unaddressed", orgId: null };
  }
  switch (scope.kind) {
    case "singleton":
    case "system":
      return { scope: "system", scopeKind: "system", orgId: null };
    case "named":
      return { scope: `named:${scope.name}`, scopeKind: "named", orgId: null };
    case "org":
    case "user":
    case "app":
    case "project":
      return {
        scope: backofficeScopePathSegment(scope),
        scopeKind: scope.kind,
        orgId: backofficeScopeOrganization(scope)?.orgId ?? null,
      };
    default:
      throw new Error("Unsupported Backoffice object scope kind.", {
        cause: scope satisfies never,
      });
  }
}

/** The span attributes for a scope; absent values are left off the span. */
export function backofficeScopeSpanAttributes(fields: BackofficeScopeFields) {
  return {
    "backoffice.scope": fields.scope ?? undefined,
    "backoffice.scope_kind": fields.scopeKind,
    "backoffice.org_id": fields.orgId ?? undefined,
  };
}

/** An operational fact a host reports for monitoring, alongside its traces and logs. */
export type BackofficeHostSignal =
  | {
      kind: "durable-hook-attempt";
      attempt: DurableHookAttempt;
      outcome: DurableHookAttemptOutcome;
    }
  | {
      /**
       * The host replaced an alarm that never fired. Until then, none of its hooks ran, and nothing
       * else reports that: a stalled queue is silent.
       */
      kind: "durable-hooks-lost-alarm";
      alarm: DurableHooksLostAlarm;
    }
  | {
      /** Hooks whose attempt died with its runtime went back to the queue. */
      kind: "durable-hooks-stuck-requeued";
      stuck: StuckHookProcessingInfo;
    }
  | {
      /** Failures outside any one hook, which the host would otherwise only log. */
      kind: "host-error";
      stage: "migration" | "dispatcher" | "hook-processor";
      error: unknown;
    }
  | {
      kind: "workflow-finished";
      workflowName: string;
      /** The script a workflow host runs for this instance, such as a Codemode workflow's name. */
      program: string | null;
      instanceId: string;
      runGeneration: number;
      outcome:
        | { status: "complete" }
        | { status: "errored"; error: { name: string; message: string } }
        | { status: "terminated" };
    }
  | {
      kind: "codemode-run-finished";
      runId: string;
      origin: CodemodeRunOrigin;
      activationKind: CodemodeRunFinishedHookPayload["activationKind"];
      durationMs: number;
      outcome:
        | { status: "completed" }
        | { status: "failed"; error: CodemodeWireError }
        | { status: "suspended" };
    }
  | {
      /** An access code admitted a new account; a retried sign-up is not reported again. */
      kind: "access-code-redeemed";
      accessCodeId: string;
      accessCodeLabel: string;
    }
  | {
      /** Recorded usage used up an owner's monthly limit; usage past it is not reported again. */
      kind: "usage-limit-reached";
      period: string;
      status: ExhaustedUsageLimit;
    };

export type BackofficeTelemetrySignal = BackofficeHostSignal & {
  object: BackofficeTelemetryObject;
};

/** Delivery is best-effort: recording never throws and never changes the outcome it describes. */
export type BackofficeTelemetry = {
  record(signal: BackofficeTelemetrySignal): void;
};

/** Records signals as one host of one object. */
export type BackofficeHostTelemetry = {
  record(signal: BackofficeHostSignal): void;
};

/** For runtimes that report nowhere, such as Node deployments. */
export const discardBackofficeTelemetry: BackofficeTelemetry = {
  record() {},
};

/**
 * Reports each terminal workflow transition on its hook's first attempt, so an owner handler that
 * retries or fails for good does not change how often it counts. An attempt whose commit loses to a
 * concurrent writer runs again as a first attempt and reports twice; that is rare enough to accept.
 */
export function reportFinishedWorkflows(
  telemetry: BackofficeHostTelemetry,
  workflowProgram: (payload: WorkflowTerminalHookPayload) => string | null,
  onWorkflowTerminal: (payload: WorkflowTerminalHookPayload, context: HookContext) => Promise<void>,
) {
  return async function (payload: WorkflowTerminalHookPayload, context: HookContext) {
    if (context.attempts === 0) {
      telemetry.record({
        kind: "workflow-finished",
        workflowName: payload.workflowName,
        program: workflowProgram(payload),
        instanceId: payload.instanceId,
        runGeneration: payload.runGeneration,
        outcome:
          payload.status === "errored"
            ? // The runner records an error with every errored transition.
              { status: "errored", error: payload.error! }
            : { status: payload.status },
      });
    }
    await onWorkflowTerminal(payload, context);
  };
}

/** Reports each finished Codemode run once, by the same first-attempt rule as workflows. */
export function reportFinishedCodemodeRuns(
  telemetry: BackofficeHostTelemetry,
  onRunFinished: (run: CodemodeRunFinishedHookPayload, context: HookContext) => Promise<void>,
) {
  return async function (run: CodemodeRunFinishedHookPayload, context: HookContext) {
    if (context.attempts === 0) {
      telemetry.record({
        kind: "codemode-run-finished",
        runId: run.runId,
        origin: run.origin,
        activationKind: run.activationKind,
        durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
        outcome:
          run.status === "failed" ? { status: "failed", error: run.error } : { status: run.status },
      });
    }
    await onRunFinished(run, context);
  };
}
