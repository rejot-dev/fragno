import {
  automationBindingsToolFamily,
  type AutomationBindingsRuntime,
} from "./families/automations-bindings";
import {
  automationScriptToolFamily,
  type ScriptRunnerRuntime,
} from "./families/automations-codemode";
import {
  automationWorkflowToolFamily,
  type AutomationWorkflowRuntime,
} from "./families/automations-workflow";
import { eventToolFamily, type EventRuntime } from "./families/event";
import { otpToolFamily, type OtpRuntime } from "./families/otp";
import { piToolFamily, type PiRuntime } from "./families/pi";
import { resendToolFamily, type ResendRuntime } from "./families/resend";
import { reson8ToolFamily, type Reson8Runtime } from "./families/reson8";
import { sandboxToolFamily, type SandboxRuntime } from "./families/sandbox";
import { telegramToolFamily, type TelegramRuntime } from "./families/telegram";
import {
  getAvailableRuntimeTools,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "./runtime-tools";

export type CoreBackofficeRuntimeMap = {
  automations?: AutomationBindingsRuntime;
  workflow?: AutomationWorkflowRuntime;
  event?: EventRuntime;
  otp?: OtpRuntime;
  pi?: PiRuntime;
  resend?: ResendRuntime;
  reson8?: Reson8Runtime;
  sandbox?: SandboxRuntime;
  telegram?: TelegramRuntime;
};

export type CoreBackofficeToolContext = BackofficeToolContext<
  CoreBackofficeRuntimeMap,
  ScriptRunnerRuntime
>;

export const automationRuntimeToolFamilies = [
  automationBindingsToolFamily,
  automationWorkflowToolFamily,
  eventToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  sandboxToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const piCodemodeRuntimeToolFamilies = [
  automationBindingsToolFamily,
  automationWorkflowToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  sandboxToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const bashRuntimeToolFamilies = [
  automationBindingsToolFamily,
  automationScriptToolFamily,
  automationWorkflowToolFamily,
  eventToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  sandboxToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const getAvailableBackofficeRuntimeTools = (context: BackofficeToolContext) =>
  getAvailableRuntimeTools({ families: automationRuntimeToolFamilies, context });
