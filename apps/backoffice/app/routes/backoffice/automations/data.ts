import type { AutomationScriptEngine, AutomationScriptLayer } from "@/fragno/automation/catalog";

type AutomationIdLike =
  | string
  | {
      externalId?: string | null;
      id?: string | null;
    }
  | null
  | undefined;

export type AutomationScriptRecord = {
  id: string;
  key: string;
  name: string;
  engine: AutomationScriptEngine;
  layer: AutomationScriptLayer;
  readOnly: boolean;
  path: string;
  absolutePath: string;
  version: number | null;
  scriptLoadError: string | null;
  enabled: boolean;
};

export type AutomationProjectRecord = {
  id?: AutomationIdLike;
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  archivedAt?: string | Date | null;
  createdByUserId?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AutomationScriptSourceRecord = {
  script: string | null;
  scriptError: string | null;
};

export const toExternalId = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if ("externalId" in value && typeof value.externalId === "string") {
    return value.externalId;
  }

  if ("id" in value && typeof value.id === "string") {
    return value.id;
  }

  const primitive = typeof value.valueOf === "function" ? value.valueOf() : null;
  if (typeof primitive === "string" && primitive !== "[object Object]") {
    return primitive;
  }

  return "";
};
