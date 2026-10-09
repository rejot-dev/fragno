import {
  type AutomationEventRecord,
  automationEventRecordSchema,
} from "@fragno-dev/backoffice-api/v0/events";

export const normalizeAutomationEventRecord = (entry: unknown): AutomationEventRecord =>
  automationEventRecordSchema.parse(entry);
