import {
  automationIdentityToolFamily,
  automationsToolFamily,
  type AutomationsRuntime,
  type ScriptRunnerRuntime,
} from "./families/automations";
import { eventToolFamily, type EventRuntime } from "./families/event";
import { otpToolFamily, type OtpRuntime } from "./families/otp";
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
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const piCodemodeRuntimeToolFamilies = [
  automationIdentityToolFamily,
  otpToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const bashRuntimeToolFamilies = [
  automationsToolFamily,
  eventToolFamily,
  otpToolFamily,
  telegramToolFamily,
] as const satisfies readonly BackofficeRuntimeToolFamily[];

export const getAvailableBackofficeRuntimeTools = (context: BackofficeToolContext) =>
  getAvailableRuntimeTools({ families: automationRuntimeToolFamilies, context });
