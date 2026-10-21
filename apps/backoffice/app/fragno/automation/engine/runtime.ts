import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  BackofficeForbiddenError,
  BackofficeKernel,
  noopBackofficeKernelObserver,
} from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BashHostContext } from "@/fragno/runtime-tools/bash-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import type {
  AutomationCommandContext,
  AutomationTriggerBinding,
} from "../../runtime-tools/automation-types";
import type { AutomationStoreRuntime } from "../../runtime-tools/families/automations-bindings";
import type { AutomationRouterRuntime } from "../../runtime-tools/families/automations-routing";
import type {} from "../../runtime-tools/families/event";
import type { EventRuntime } from "../../runtime-tools/families/event-runtime";
import type {} from "../../runtime-tools/families/otp";
import type { OtpRuntime } from "../../runtime-tools/families/otp-runtime";

export type AutomationRuntime = AutomationStoreRuntime &
  AutomationRouterRuntime &
  OtpRuntime &
  EventRuntime;

type AutomationRuntimeCommandContext = AutomationCommandContext & {
  runtime: AutomationRuntime;
};

export type AutomationRuntimeHostContext = Omit<
  BashHostContext,
  "automation" | "automations" | "otp"
> & {
  automation: AutomationRuntimeCommandContext;
  automations: {
    runtime: AutomationStoreRuntime & AutomationRouterRuntime;
  };
  otp: {
    runtime: OtpRuntime;
  };
};

export const createAutomationRuntimeHostContext = ({
  event,
  binding,
  idempotencyKey,
  runtime,
  runtimeServices,
  kernel,
  execution,
}: {
  event: AutomationEvent;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
  runtime: AutomationRuntime;
  runtimeServices?: BackofficeRuntimeServices;
  kernel?: BackofficeKernel;
  execution: BackofficeExecutionContext;
}): AutomationRuntimeHostContext => {
  const backofficeKernel =
    kernel ??
    new BackofficeKernel(
      runtimeServices ?? {
        authorityResolver: unavailableBackofficeAuthorityResolver,
        kernelObserver: noopBackofficeKernelObserver,
      },
    );

  const routeBacked = runtimeServices
    ? createRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: runtimeServices,
        kernel: backofficeKernel,
        execution,
        billingOrganizationId: null,
      })
    : null;

  return {
    ...(routeBacked ?? {
      execution,
      backofficeKernel,
      createBackofficeScopedContext: () => {
        throw new BackofficeForbiddenError("Backoffice runtime services are not configured.");
      },
      apps: null,
      backoffice: null,
      workflow: null,
      durableHooks: null,
      mcp: null,
      marketplace: null,
      packages: null,
      pi: null,
      projects: null,
      integrations: null,
      sandbox: null,
    }),
    automation: {
      event,
      orgId: backofficeScopeOrganization(event.scope)?.orgId,
      binding,
      idempotencyKey,
      runtime,
    },
    automations: routeBacked?.automations ? { ...routeBacked.automations, runtime } : { runtime },
    otp: {
      runtime,
    },
  };
};
