import {
  automationIdentityToolFamily,
  automationsToolFamily,
  type AutomationsRuntime,
  type ScriptRunnerRuntime,
} from "./families/automations";
import { eventToolFamily, type EventRuntime } from "./families/event";
import { otpToolFamily, type OtpRuntime } from "./families/otp";
import { piToolFamily, type PiRuntime } from "./families/pi";
import { resendToolFamily, type ResendRuntime } from "./families/resend";
import { reson8ToolFamily, type Reson8Runtime } from "./families/reson8";
import { telegramToolFamily, type TelegramRuntime } from "./families/telegram";
import {
  getAvailableRuntimeTools,
  type BackofficeRuntimeToolFamily,
  type BackofficeToolContext,
} from "./runtime-tools";

export type CoreBackofficeRuntimeMap = {
  automations?: AutomationsRuntime;
  event?: EventRuntime;
  otp?: OtpRuntime;
  pi?: PiRuntime;
  resend?: ResendRuntime;
  reson8?: Reson8Runtime;
  telegram?: TelegramRuntime;
};

export type CoreBackofficeToolContext = BackofficeToolContext<
  CoreBackofficeRuntimeMap,
  ScriptRunnerRuntime
>;

export const automationRuntimeToolFamilies = [
  automationIdentityToolFamily,
  eventToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const piCodemodeRuntimeToolFamilies = [
  automationIdentityToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const bashRuntimeToolFamilies = [
  automationsToolFamily,
  eventToolFamily,
  otpToolFamily,
  piToolFamily,
  resendToolFamily,
  reson8ToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const getAvailableBackofficeRuntimeTools = (context: BackofficeToolContext) =>
  getAvailableRuntimeTools({ families: automationRuntimeToolFamilies, context });
