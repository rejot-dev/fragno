import { FragnoId } from "@fragno-dev/db/schema";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const toExternalId = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return `${value}`;
  }
  if (value instanceof FragnoId) {
    return value.externalId;
  }
  throw new Error("Expected external id to be a string, number, or FragnoId.");
};

export const toStringValue = (value: unknown) => toExternalId(value);

export const normalizeJoinedLinks = <T extends { linkKey?: string | null }>(
  links: T | T[] | null | undefined,
) => {
  const entries = Array.isArray(links) ? links : links ? [links] : [];
  return entries.filter((link) => typeof link.linkKey === "string" && link.linkKey.length > 0);
};

export const normalizeJoinedInstallation = <T extends { id?: unknown }>(
  installation: T | null | undefined,
) => {
  if (!installation) {
    return null;
  }
  return toExternalId(installation.id) ? installation : null;
};
