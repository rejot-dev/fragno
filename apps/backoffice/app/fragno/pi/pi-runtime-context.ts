import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import type {
  InteractiveRuntimeToolContext,
  RegisteredAutomationsRuntime,
} from "@/fragno/runtime-tools/bash-host";
import type { OtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import type { ResendRuntime } from "@/fragno/runtime-tools/families/resend";
import type { TelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";

import type { PiManagerRuntime } from "../pi-manager/pi-manager-runtime";

/** Runtime services available to Backoffice tools executed by a durable Pi agent. */
export type PiRuntimeToolContext = InteractiveRuntimeToolContext & {
  automations: { runtime: RegisteredAutomationsRuntime };
  otp: { runtime: OtpRuntime };
  pi: { runtime: PiManagerRuntime };
  resend: { runtime: ResendRuntime };
  telegram: { runtime: TelegramRuntime };
};

/** Returns the scoped filesystem used by durable Pi tools and prompt sections. */
export function requirePiStateBackend(context: PiRuntimeToolContext): BackofficeStateBackend {
  if (!context.stateBackend) {
    throw new Error("Pi requires a state backend.");
  }
  return context.stateBackend;
}
