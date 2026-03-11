export interface CloudflareScriptNameConfig {
  scriptNamePrefix?: string;
  scriptNameSuffix?: string;
  scriptNameSeparator?: string;
  maxScriptNameLength?: number;
}

export const DEFAULT_SCRIPT_NAME_SEPARATOR = "-";
export const DEFAULT_MAX_SCRIPT_NAME_LENGTH = 63;

const normalizeSeparator = (value?: string) => {
  const cleaned = (value ?? DEFAULT_SCRIPT_NAME_SEPARATOR).replace(/[^a-z0-9-]+/gi, "-");
  return cleaned.length > 0 ? cleaned : DEFAULT_SCRIPT_NAME_SEPARATOR;
};

const sanitizeSegment = (value: string) => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-");
};

const hashString = (value: string) => {
  let hash = 2166136261;

  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const resolveCloudflareScriptName = (
  appId: string,
  config: CloudflareScriptNameConfig = {},
) => {
  const separator = normalizeSeparator(config.scriptNameSeparator);
  const maxLength = Math.max(16, config.maxScriptNameLength ?? DEFAULT_MAX_SCRIPT_NAME_LENGTH);
  const segments = [config.scriptNamePrefix, appId, config.scriptNameSuffix]
    .map((segment) => sanitizeSegment(segment ?? ""))
    .filter(Boolean);
  const base = segments.join(separator) || "app";

  if (base.length <= maxLength) {
    return base;
  }

  const hash = hashString(base);
  const budget = Math.max(1, maxLength - hash.length - separator.length);
  const trimmedBase = base.slice(0, budget).replace(/-+$/, "") || "app";
  const candidate = `${trimmedBase}${separator}${hash}`;

  return candidate.slice(0, maxLength).replace(/-+$/, "");
};
