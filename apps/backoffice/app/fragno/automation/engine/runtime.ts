import type { BashHostContext } from "@/fragno/runtime-tools/bash-host";

import type { AutomationCommandContext } from "../../runtime-tools/automation-types";
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
