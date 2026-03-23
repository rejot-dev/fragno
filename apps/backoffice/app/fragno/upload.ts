export const UPLOAD_PROVIDER_R2 = "r2" as const;
export const UPLOAD_PROVIDER_R2_BINDING = "r2-binding" as const;
export const UPLOAD_ADMIN_CONFIG_KEY = "upload-config" as const;
export const UPLOAD_R2_DEFAULT_BINDING_NAME = "UPLOAD_BUCKET" as const;
const ORG_PREFIX_ROOT = "org" as const;

export type UploadProvider = typeof UPLOAD_PROVIDER_R2 | typeof UPLOAD_PROVIDER_R2_BINDING;

const UPLOAD_PROVIDERS: readonly UploadProvider[] = [
  UPLOAD_PROVIDER_R2_BINDING,
  UPLOAD_PROVIDER_R2,
] as const;

export type UploadR2Limits = {
  directUploadThresholdBytes?: number;
  multipartThresholdBytes?: number;
  multipartPartSizeBytes?: number;
  uploadExpiresInSeconds?: number;
  signedUrlExpiresInSeconds?: number;
  maxSingleUploadBytes?: number;
  maxMultipartUploadBytes?: number;
  maxMetadataBytes?: number;
};

export type UploadR2SignerConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
};

export type UploadR2Config = {
  bucket: string;
  endpoint: string;
  pathStyle: boolean;
  storageKeySuffix?: string;
  signer: UploadR2SignerConfig;
  limits?: UploadR2Limits;
};

export type UploadR2BindingConfig = {
  bindingName: string;
  storageKeySuffix?: string;
  limits?: UploadR2Limits;
};

export type UploadNamespaceConfig = {
  orgId: string;
  orgPrefix: string;
};

type StoredUploadProviderConfigBase = {
  createdAt: string;
  updatedAt: string;
};

export type StoredUploadProviderConfigR2 = StoredUploadProviderConfigBase & {
  provider: typeof UPLOAD_PROVIDER_R2;
  r2: UploadR2Config;
};

export type StoredUploadProviderConfigR2Binding = StoredUploadProviderConfigBase & {
  provider: typeof UPLOAD_PROVIDER_R2_BINDING;
  r2Binding: UploadR2BindingConfig;
};

export type StoredUploadProviderConfig =
  | StoredUploadProviderConfigR2
  | StoredUploadProviderConfigR2Binding;

export type UploadProviderConfigMap = Partial<{
  [UPLOAD_PROVIDER_R2]: StoredUploadProviderConfigR2;
  [UPLOAD_PROVIDER_R2_BINDING]: StoredUploadProviderConfigR2Binding;
}>;

export type StoredUploadAdminConfig = {
  namespace: UploadNamespaceConfig;
  defaultProvider: UploadProvider;
  providers: UploadProviderConfigMap;
  createdAt: string;
  updatedAt: string;
};

type LegacyStoredUploadAdminConfigBase = {
  provider: UploadProvider;
  namespace: UploadNamespaceConfig & { storageKeyPrefix?: string };
  createdAt: string;
  updatedAt: string;
};

type LegacyStoredUploadAdminConfigR2 = LegacyStoredUploadAdminConfigBase & {
  provider: typeof UPLOAD_PROVIDER_R2;
  r2: UploadR2Config;
};

type LegacyStoredUploadAdminConfigR2Binding = LegacyStoredUploadAdminConfigBase & {
  provider: typeof UPLOAD_PROVIDER_R2_BINDING;
  r2Binding: UploadR2BindingConfig;
};

type LegacyStoredUploadAdminConfig =
  | LegacyStoredUploadAdminConfigR2
  | LegacyStoredUploadAdminConfigR2Binding;

export type UploadAdminSetConfigPayload = {
  provider?: UploadProvider;
  defaultProvider?: UploadProvider;
  bindingName?: string;
  bucket?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  sessionToken?: string | null;
  pathStyle?: boolean;
  storageKeySuffix?: string | null;
  directUploadThresholdBytes?: number | string | null;
  multipartThresholdBytes?: number | string | null;
  multipartPartSizeBytes?: number | string | null;
  uploadExpiresInSeconds?: number | string | null;
  signedUrlExpiresInSeconds?: number | string | null;
  maxSingleUploadBytes?: number | string | null;
  maxMultipartUploadBytes?: number | string | null;
  maxMetadataBytes?: number | string | null;
};

type UploadAdminProviderConfigBase = {
  orgPrefix?: string;
  storageKeyPrefix?: string;
  storageKeySuffix?: string | null;
  limits?: UploadR2Limits;
  createdAt?: string;
  updatedAt?: string;
};

export type UploadAdminProviderResponseR2 = {
  provider: typeof UPLOAD_PROVIDER_R2;
  configured: boolean;
  config?: UploadAdminProviderConfigBase & {
    bucket?: string | null;
    endpoint?: string | null;
    pathStyle?: boolean;
    region?: string | null;
    sessionTokenConfigured?: boolean;
    accessKeyIdPreview?: string;
    secretAccessKeyPreview?: string;
  };
};

export type UploadAdminProviderResponseR2Binding = {
  provider: typeof UPLOAD_PROVIDER_R2_BINDING;
  configured: boolean;
  config?: UploadAdminProviderConfigBase & {
    bindingName?: string | null;
  };
};

type UploadAdminProviderMap = Partial<{
  [UPLOAD_PROVIDER_R2]: UploadAdminProviderResponseR2;
  [UPLOAD_PROVIDER_R2_BINDING]: UploadAdminProviderResponseR2Binding;
}>;

export type UploadAdminConfigResponse = {
  configured: boolean;
  defaultProvider: UploadProvider | null;
  providers: UploadAdminProviderMap;
};

type UploadLimitField = keyof UploadR2Limits;

const UPLOAD_LIMIT_FIELDS: readonly UploadLimitField[] = [
  "directUploadThresholdBytes",
  "multipartThresholdBytes",
  "multipartPartSizeBytes",
  "uploadExpiresInSeconds",
  "signedUrlExpiresInSeconds",
  "maxSingleUploadBytes",
  "maxMultipartUploadBytes",
  "maxMetadataBytes",
] as const;

const uploadLimitAllowsZero = (field: UploadLimitField) => field === "maxMetadataBytes";

const isFiniteInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);

const isAcceptedUploadLimitValue = (field: UploadLimitField, value: unknown): value is number => {
  if (!isFiniteInteger(value)) {
    return false;
  }

  return uploadLimitAllowsZero(field) ? value >= 0 : value > 0;
};

const ALLOWED_INPUT_FIELDS = new Set<string>([
  "provider",
  "defaultProvider",
  "bindingName",
  "bucket",
  "endpoint",
  "accessKeyId",
  "secretAccessKey",
  "region",
  "sessionToken",
  "pathStyle",
  "storageKeySuffix",
  ...UPLOAD_LIMIT_FIELDS,
]);

type ResolveConfigResult =
  | { ok: true; config: StoredUploadAdminConfig }
  | { ok: false; message: string };

type ReadStringResult =
  | { ok: true; provided: boolean; value: string | null }
  | { ok: false; message: string };

type ReadBooleanResult =
  | { ok: true; provided: boolean; value: boolean }
  | { ok: false; message: string };

type ReadIntegerResult =
  | { ok: true; provided: boolean; value: number | null }
  | { ok: false; message: string };

const hasOwn = (record: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUploadProvider = (value: string): value is UploadProvider =>
  value === UPLOAD_PROVIDER_R2 || value === UPLOAD_PROVIDER_R2_BINDING;

const maskSecret = (value: string) => {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const normalizeEndpoint = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }

    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/g, "");

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

const normalizeOrgId = (orgId: string) => {
  const normalized = orgId.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
};

const normalizeOrgPrefixSegment = (orgId: string) => {
  const safe = orgId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!safe) {
    return null;
  }

  return safe;
};

const normalizeStorageKeySuffix = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error("Storage key suffix cannot contain '.' or '..' segments.");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(
        "Storage key suffix can only contain letters, numbers, '.', '_', '-', and '/'.",
      );
    }
  }

  return segments.join("/");
};

const validateBucket = (value: string) => {
  if (value.length < 3 || value.length > 63) {
    return "R2 bucket must be between 3 and 63 characters.";
  }

  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    return "R2 bucket must use lowercase letters, numbers, dots, and hyphens.";
  }

  if (value.includes("..") || value.includes(".-") || value.includes("-.")) {
    return "R2 bucket has an invalid dot or hyphen sequence.";
  }

  return null;
};

const validateBindingName = (value: string) => {
  if (!value) {
    return "R2 bucket binding name is required.";
  }

  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    return "R2 bucket binding name must start with a letter and contain only A-Z, 0-9, and '_'.";
  }

  return null;
};

const parseInputObject = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false as const,
      message: "Request body must be a JSON object.",
    };
  }

  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      return {
        ok: false as const,
        message: `Unsupported field '${key}' in upload config payload.`,
      };
    }
  }

  return {
    ok: true as const,
    record,
  };
};

const readOptionalStringField = (
  record: Record<string, unknown>,
  field: string,
): ReadStringResult => {
  if (!hasOwn(record, field)) {
    return { ok: true, provided: false, value: null };
  }

  const raw = record[field];
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }

  if (typeof raw !== "string") {
    return {
      ok: false,
      message: `Field '${field}' must be a string.`,
    };
  }

  const trimmed = raw.trim();
  return {
    ok: true,
    provided: true,
    value: trimmed.length > 0 ? trimmed : null,
  };
};

const readOptionalBooleanField = (
  record: Record<string, unknown>,
  field: string,
): ReadBooleanResult => {
  if (!hasOwn(record, field)) {
    return { ok: true, provided: false, value: false };
  }

  const raw = record[field];
  if (typeof raw !== "boolean") {
    return {
      ok: false,
      message: `Field '${field}' must be a boolean.`,
    };
  }

  return { ok: true, provided: true, value: raw };
};

const readOptionalIntegerField = (
  record: Record<string, unknown>,
  field: UploadLimitField,
): ReadIntegerResult => {
  if (!hasOwn(record, field)) {
    return { ok: true, provided: false, value: null };
  }

  const raw = record[field];
  if (raw === null) {
    return { ok: true, provided: true, value: null };
  }

  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: true, provided: true, value: null };
    }
    if (!/^\d+$/.test(trimmed)) {
      return {
        ok: false,
        message: `Field '${field}' must be an integer.`,
      };
    }
    parsed = Number.parseInt(trimmed, 10);
  } else {
    return {
      ok: false,
      message: `Field '${field}' must be an integer.`,
    };
  }

  if (!isFiniteInteger(parsed)) {
    return {
      ok: false,
      message: `Field '${field}' must be an integer.`,
    };
  }

  if (!isAcceptedUploadLimitValue(field, parsed)) {
    return {
      ok: false,
      message: uploadLimitAllowsZero(field)
        ? `Field '${field}' must be zero or a positive integer.`
        : `Field '${field}' must be a positive integer.`,
    };
  }

  return {
    ok: true,
    provided: true,
    value: parsed,
  };
};

export const resolveUploadOrgPrefix = (orgId: string) => {
  const normalizedOrgId = normalizeOrgId(orgId);
  if (!normalizedOrgId) {
    throw new Error("Missing organisation id.");
  }

  const orgSegment = normalizeOrgPrefixSegment(normalizedOrgId);
  if (!orgSegment) {
    throw new Error("Organisation id could not be converted into a storage prefix.");
  }

  return `${ORG_PREFIX_ROOT}/${orgSegment}`;
};

export const resolveUploadStorageKeyPrefix = (
  orgId: string,
  storageKeySuffix?: string | null,
): string => {
  const orgPrefix = resolveUploadOrgPrefix(orgId);
  const suffix = normalizeStorageKeySuffix(storageKeySuffix);

  if (!suffix) {
    return orgPrefix;
  }

  return `${orgPrefix}/${suffix}`;
};

const parseLimits = (value: unknown): UploadR2Limits | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const limits: UploadR2Limits = {};
  for (const field of UPLOAD_LIMIT_FIELDS) {
    const raw = value[field];
    if (isAcceptedUploadLimitValue(field, raw)) {
      limits[field] = raw;
    }
  }

  return Object.keys(limits).length > 0 ? limits : undefined;
};

const parseR2SignerConfig = (value: unknown): UploadR2SignerConfig | null => {
  if (!isRecord(value)) {
    return null;
  }

  const accessKeyId = typeof value.accessKeyId === "string" ? value.accessKeyId : null;
  const secretAccessKey = typeof value.secretAccessKey === "string" ? value.secretAccessKey : null;
  const region = typeof value.region === "string" ? value.region : null;
  const sessionToken = typeof value.sessionToken === "string" ? value.sessionToken : undefined;

  if (!accessKeyId || !secretAccessKey || !region) {
    return null;
  }

  return {
    accessKeyId,
    secretAccessKey,
    region,
    ...(sessionToken ? { sessionToken } : {}),
  };
};

const parseUploadR2Config = (value: unknown): UploadR2Config | null => {
  if (!isRecord(value)) {
    return null;
  }

  const bucket = typeof value.bucket === "string" ? value.bucket : null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint : null;
  const pathStyle = typeof value.pathStyle === "boolean" ? value.pathStyle : null;
  const signer = parseR2SignerConfig(value.signer);

  if (!bucket || !endpoint || pathStyle === null || !signer) {
    return null;
  }

  let storageKeySuffix: string | undefined;
  try {
    storageKeySuffix =
      typeof value.storageKeySuffix === "string"
        ? (normalizeStorageKeySuffix(value.storageKeySuffix) ?? undefined)
        : undefined;
  } catch {
    return null;
  }

  const limits = parseLimits(value.limits);

  return {
    bucket,
    endpoint,
    pathStyle,
    signer,
    ...(storageKeySuffix ? { storageKeySuffix } : {}),
    ...(limits ? { limits } : {}),
  };
};

const parseUploadR2BindingConfig = (value: unknown): UploadR2BindingConfig | null => {
  if (!isRecord(value)) {
    return null;
  }

  const bindingName = typeof value.bindingName === "string" ? value.bindingName : null;
  if (!bindingName) {
    return null;
  }

  let storageKeySuffix: string | undefined;
  try {
    storageKeySuffix =
      typeof value.storageKeySuffix === "string"
        ? (normalizeStorageKeySuffix(value.storageKeySuffix) ?? undefined)
        : undefined;
  } catch {
    return null;
  }

  const limits = parseLimits(value.limits);

  return {
    bindingName,
    ...(storageKeySuffix ? { storageKeySuffix } : {}),
    ...(limits ? { limits } : {}),
  };
};

const parseNamespace = (value: unknown): UploadNamespaceConfig | null => {
  if (!isRecord(value) || typeof value.orgId !== "string") {
    return null;
  }

  const normalizedOrgId = normalizeOrgId(value.orgId);
  if (!normalizedOrgId) {
    return null;
  }

  const orgPrefixValue = typeof value.orgPrefix === "string" ? value.orgPrefix.trim() : "";
  if (orgPrefixValue) {
    return {
      orgId: normalizedOrgId,
      orgPrefix: orgPrefixValue,
    };
  }

  try {
    return {
      orgId: normalizedOrgId,
      orgPrefix: resolveUploadOrgPrefix(normalizedOrgId),
    };
  } catch {
    return null;
  }
};

const parseStoredR2ProviderConfig = (
  value: unknown,
  timestamps: { createdAt: string; updatedAt: string },
): StoredUploadProviderConfigR2 | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (value.provider !== UPLOAD_PROVIDER_R2 || !hasOwn(value, "r2")) {
    return null;
  }

  const parsedR2 = parseUploadR2Config(value.r2);
  if (!parsedR2) {
    return null;
  }

  const createdAt = typeof value.createdAt === "string" ? value.createdAt : timestamps.createdAt;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : timestamps.updatedAt;

  return {
    provider: UPLOAD_PROVIDER_R2,
    r2: parsedR2,
    createdAt,
    updatedAt,
  };
};

const parseStoredR2BindingProviderConfig = (
  value: unknown,
  timestamps: { createdAt: string; updatedAt: string },
): StoredUploadProviderConfigR2Binding | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (value.provider !== UPLOAD_PROVIDER_R2_BINDING || !hasOwn(value, "r2Binding")) {
    return null;
  }

  const parsedR2Binding = parseUploadR2BindingConfig(value.r2Binding);
  if (!parsedR2Binding) {
    return null;
  }

  const createdAt = typeof value.createdAt === "string" ? value.createdAt : timestamps.createdAt;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : timestamps.updatedAt;

  return {
    provider: UPLOAD_PROVIDER_R2_BINDING,
    r2Binding: parsedR2Binding,
    createdAt,
    updatedAt,
  };
};

const isProviderConfigConfigured = (
  orgId: string,
  providerConfig: StoredUploadProviderConfig | undefined | null,
) => {
  if (!providerConfig) {
    return false;
  }

  try {
    if (providerConfig.provider === UPLOAD_PROVIDER_R2) {
      if (
        !providerConfig.r2.bucket ||
        !providerConfig.r2.endpoint ||
        !providerConfig.r2.signer.accessKeyId ||
        !providerConfig.r2.signer.secretAccessKey
      ) {
        return false;
      }

      return Boolean(resolveUploadStorageKeyPrefix(orgId, providerConfig.r2.storageKeySuffix));
    }

    if (!providerConfig.r2Binding.bindingName) {
      return false;
    }

    return Boolean(resolveUploadStorageKeyPrefix(orgId, providerConfig.r2Binding.storageKeySuffix));
  } catch {
    return false;
  }
};

const resolveDefaultProvider = (
  orgId: string,
  providers: UploadProviderConfigMap,
  preferred?: UploadProvider | null,
): UploadProvider | null => {
  if (preferred && isProviderConfigConfigured(orgId, providers[preferred])) {
    return preferred;
  }

  for (const provider of UPLOAD_PROVIDERS) {
    if (isProviderConfigConfigured(orgId, providers[provider])) {
      return provider;
    }
  }

  return null;
};

export const normalizeStoredUploadAdminConfig = (
  value: StoredUploadAdminConfig | LegacyStoredUploadAdminConfig | unknown,
): StoredUploadAdminConfig | null => {
  if (!isRecord(value)) {
    return null;
  }

  const now = new Date().toISOString();
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : now;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  const namespace = parseNamespace(value.namespace);
  if (!namespace) {
    return null;
  }

  if (isRecord(value.providers)) {
    const providers: UploadProviderConfigMap = {};

    const r2 = parseStoredR2ProviderConfig(value.providers[UPLOAD_PROVIDER_R2], {
      createdAt,
      updatedAt,
    });
    if (r2) {
      providers[UPLOAD_PROVIDER_R2] = r2;
    }

    const r2Binding = parseStoredR2BindingProviderConfig(
      value.providers[UPLOAD_PROVIDER_R2_BINDING],
      {
        createdAt,
        updatedAt,
      },
    );
    if (r2Binding) {
      providers[UPLOAD_PROVIDER_R2_BINDING] = r2Binding;
    }

    const defaultProviderRaw =
      typeof value.defaultProvider === "string" && isUploadProvider(value.defaultProvider)
        ? value.defaultProvider
        : null;
    const defaultProvider = resolveDefaultProvider(namespace.orgId, providers, defaultProviderRaw);
    if (!defaultProvider) {
      return null;
    }

    return {
      namespace,
      defaultProvider,
      providers,
      createdAt,
      updatedAt,
    };
  }

  if (typeof value.provider !== "string" || !isUploadProvider(value.provider)) {
    return null;
  }

  const providers: UploadProviderConfigMap = {};
  if (value.provider === UPLOAD_PROVIDER_R2) {
    const parsedR2 = parseUploadR2Config((value as LegacyStoredUploadAdminConfigR2).r2);
    if (!parsedR2) {
      return null;
    }
    providers[UPLOAD_PROVIDER_R2] = {
      provider: UPLOAD_PROVIDER_R2,
      r2: parsedR2,
      createdAt,
      updatedAt,
    };
  } else {
    const parsedR2Binding = parseUploadR2BindingConfig(
      (value as LegacyStoredUploadAdminConfigR2Binding).r2Binding,
    );
    if (!parsedR2Binding) {
      return null;
    }
    providers[UPLOAD_PROVIDER_R2_BINDING] = {
      provider: UPLOAD_PROVIDER_R2_BINDING,
      r2Binding: parsedR2Binding,
      createdAt,
      updatedAt,
    };
  }

  const defaultProvider = resolveDefaultProvider(namespace.orgId, providers, value.provider);
  if (!defaultProvider) {
    return null;
  }

  return {
    namespace,
    defaultProvider,
    providers,
    createdAt,
    updatedAt,
  };
};

export const resolveUploadProviderStorageKeyPrefix = (
  config: StoredUploadAdminConfig,
  provider: UploadProvider,
) => {
  const providerConfig = config.providers[provider];
  if (!providerConfig) {
    throw new Error(`Upload provider '${provider}' is not configured.`);
  }

  const suffix =
    providerConfig.provider === UPLOAD_PROVIDER_R2
      ? providerConfig.r2.storageKeySuffix
      : providerConfig.r2Binding.storageKeySuffix;

  return resolveUploadStorageKeyPrefix(config.namespace.orgId, suffix);
};

export const resolveUploadAdminConfigInput = (input: {
  payload: unknown;
  orgId: string;
  existing?: StoredUploadAdminConfig | LegacyStoredUploadAdminConfig | null;
  now?: string;
}): ResolveConfigResult => {
  const parsedPayload = parseInputObject(input.payload);
  if (!parsedPayload.ok) {
    return parsedPayload;
  }

  const normalizedOrgId = normalizeOrgId(input.orgId);
  if (!normalizedOrgId) {
    return { ok: false, message: "Missing organisation id." };
  }

  const record = parsedPayload.record;
  const existing = input.existing ? normalizeStoredUploadAdminConfig(input.existing) : null;

  const providerField = readOptionalStringField(record, "provider");
  if (!providerField.ok) {
    return providerField;
  }

  const providerValue = providerField.provided
    ? (providerField.value ?? "")
    : (existing?.defaultProvider ?? UPLOAD_PROVIDER_R2_BINDING);
  if (!isUploadProvider(providerValue)) {
    return {
      ok: false,
      message: "Only providers 'r2' and 'r2-binding' are supported.",
    };
  }
  const provider = providerValue;

  const defaultProviderField = readOptionalStringField(record, "defaultProvider");
  if (!defaultProviderField.ok) {
    return defaultProviderField;
  }

  let requestedDefaultProvider: UploadProvider | null = null;
  if (defaultProviderField.provided) {
    if (!defaultProviderField.value || !isUploadProvider(defaultProviderField.value)) {
      return {
        ok: false,
        message: "Field 'defaultProvider' must be either 'r2' or 'r2-binding'.",
      };
    }
    requestedDefaultProvider = defaultProviderField.value;
  }

  let orgPrefix: string;
  try {
    orgPrefix = resolveUploadOrgPrefix(normalizedOrgId);
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Organisation id could not be converted into a storage prefix.",
    };
  }

  const now = input.now ?? new Date().toISOString();
  const providers: UploadProviderConfigMap = { ...existing?.providers };

  if (provider === UPLOAD_PROVIDER_R2_BINDING) {
    const existingBinding = existing?.providers[UPLOAD_PROVIDER_R2_BINDING];

    const limits: UploadR2Limits = { ...existingBinding?.r2Binding.limits };
    for (const field of UPLOAD_LIMIT_FIELDS) {
      const parsed = readOptionalIntegerField(record, field);
      if (!parsed.ok) {
        return parsed;
      }
      if (!parsed.provided) {
        continue;
      }
      if (parsed.value === null) {
        delete limits[field];
        continue;
      }
      limits[field] = parsed.value;
    }

    const storageKeySuffixField = readOptionalStringField(record, "storageKeySuffix");
    if (!storageKeySuffixField.ok) {
      return storageKeySuffixField;
    }

    const storageKeySuffixRaw = storageKeySuffixField.provided
      ? storageKeySuffixField.value
      : (existingBinding?.r2Binding.storageKeySuffix ?? null);

    let storageKeySuffix: string | undefined;
    try {
      storageKeySuffix = normalizeStorageKeySuffix(storageKeySuffixRaw) ?? undefined;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Storage key suffix is invalid.",
      };
    }

    const bindingNameField = readOptionalStringField(record, "bindingName");
    if (!bindingNameField.ok) {
      return bindingNameField;
    }

    const bindingName = bindingNameField.provided
      ? (bindingNameField.value ?? "")
      : (existingBinding?.r2Binding.bindingName ?? UPLOAD_R2_DEFAULT_BINDING_NAME);

    const bindingNameError = validateBindingName(bindingName);
    if (bindingNameError) {
      return { ok: false, message: bindingNameError };
    }

    providers[UPLOAD_PROVIDER_R2_BINDING] = {
      provider: UPLOAD_PROVIDER_R2_BINDING,
      r2Binding: {
        bindingName,
        ...(storageKeySuffix ? { storageKeySuffix } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
      },
      createdAt: existingBinding?.createdAt ?? now,
      updatedAt: now,
    };
  } else {
    const existingR2 = existing?.providers[UPLOAD_PROVIDER_R2];

    const limits: UploadR2Limits = { ...existingR2?.r2.limits };
    for (const field of UPLOAD_LIMIT_FIELDS) {
      const parsed = readOptionalIntegerField(record, field);
      if (!parsed.ok) {
        return parsed;
      }
      if (!parsed.provided) {
        continue;
      }
      if (parsed.value === null) {
        delete limits[field];
        continue;
      }
      limits[field] = parsed.value;
    }

    const storageKeySuffixField = readOptionalStringField(record, "storageKeySuffix");
    if (!storageKeySuffixField.ok) {
      return storageKeySuffixField;
    }

    const storageKeySuffixRaw = storageKeySuffixField.provided
      ? storageKeySuffixField.value
      : (existingR2?.r2.storageKeySuffix ?? null);

    let storageKeySuffix: string | undefined;
    try {
      storageKeySuffix = normalizeStorageKeySuffix(storageKeySuffixRaw) ?? undefined;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Storage key suffix is invalid.",
      };
    }

    const bucketField = readOptionalStringField(record, "bucket");
    if (!bucketField.ok) {
      return bucketField;
    }
    const bucket = bucketField.provided ? (bucketField.value ?? "") : (existingR2?.r2.bucket ?? "");
    if (!bucket) {
      return { ok: false, message: "R2 bucket is required." };
    }
    const bucketError = validateBucket(bucket);
    if (bucketError) {
      return { ok: false, message: bucketError };
    }

    const endpointField = readOptionalStringField(record, "endpoint");
    if (!endpointField.ok) {
      return endpointField;
    }
    const endpointRaw = endpointField.provided
      ? (endpointField.value ?? "")
      : (existingR2?.r2.endpoint ?? "");
    if (!endpointRaw) {
      return { ok: false, message: "R2 endpoint is required." };
    }
    const endpoint = normalizeEndpoint(endpointRaw);
    if (!endpoint) {
      return {
        ok: false,
        message: "R2 endpoint must be a valid absolute HTTP(S) URL without credentials.",
      };
    }

    const accessKeyIdField = readOptionalStringField(record, "accessKeyId");
    if (!accessKeyIdField.ok) {
      return accessKeyIdField;
    }
    const accessKeyId = accessKeyIdField.provided
      ? (accessKeyIdField.value ?? "")
      : (existingR2?.r2.signer.accessKeyId ?? "");
    if (!accessKeyId) {
      return { ok: false, message: "R2 access key id is required." };
    }

    const secretAccessKeyField = readOptionalStringField(record, "secretAccessKey");
    if (!secretAccessKeyField.ok) {
      return secretAccessKeyField;
    }
    const secretAccessKey = secretAccessKeyField.provided
      ? (secretAccessKeyField.value ?? "")
      : (existingR2?.r2.signer.secretAccessKey ?? "");
    if (!secretAccessKey) {
      return { ok: false, message: "R2 secret access key is required." };
    }

    const regionField = readOptionalStringField(record, "region");
    if (!regionField.ok) {
      return regionField;
    }
    const region = regionField.provided
      ? (regionField.value ?? "auto")
      : (existingR2?.r2.signer.region ?? "auto");
    if (!region || /\s/.test(region)) {
      return { ok: false, message: "R2 region must be a non-empty string without whitespace." };
    }

    const sessionTokenField = readOptionalStringField(record, "sessionToken");
    if (!sessionTokenField.ok) {
      return sessionTokenField;
    }
    const sessionToken = sessionTokenField.provided
      ? (sessionTokenField.value ?? undefined)
      : existingR2?.r2.signer.sessionToken;

    const pathStyleField = readOptionalBooleanField(record, "pathStyle");
    if (!pathStyleField.ok) {
      return pathStyleField;
    }
    const pathStyle = pathStyleField.provided
      ? pathStyleField.value
      : (existingR2?.r2.pathStyle ?? true);

    providers[UPLOAD_PROVIDER_R2] = {
      provider: UPLOAD_PROVIDER_R2,
      r2: {
        bucket,
        endpoint,
        pathStyle,
        ...(storageKeySuffix ? { storageKeySuffix } : {}),
        signer: {
          accessKeyId,
          secretAccessKey,
          region,
          ...(sessionToken ? { sessionToken } : {}),
        },
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
      },
      createdAt: existingR2?.createdAt ?? now,
      updatedAt: now,
    };
  }

  if (
    requestedDefaultProvider &&
    !isProviderConfigConfigured(normalizedOrgId, providers[requestedDefaultProvider])
  ) {
    return {
      ok: false,
      message: `Default provider '${requestedDefaultProvider}' is not configured.`,
    };
  }

  const defaultProvider = resolveDefaultProvider(
    normalizedOrgId,
    providers,
    requestedDefaultProvider ?? existing?.defaultProvider ?? provider,
  );
  if (!defaultProvider) {
    return {
      ok: false,
      message: "At least one provider must be configured.",
    };
  }

  return {
    ok: true,
    config: {
      namespace: {
        orgId: normalizedOrgId,
        orgPrefix,
      },
      defaultProvider,
      providers,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
  };
};

const buildProviderResponse = (
  namespace: UploadNamespaceConfig,
  providerConfig: StoredUploadProviderConfig,
): UploadAdminProviderResponseR2 | UploadAdminProviderResponseR2Binding => {
  if (providerConfig.provider === UPLOAD_PROVIDER_R2_BINDING) {
    const storageKeyPrefix = resolveUploadStorageKeyPrefix(
      namespace.orgId,
      providerConfig.r2Binding.storageKeySuffix,
    );
    return {
      provider: UPLOAD_PROVIDER_R2_BINDING,
      configured: isProviderConfigConfigured(namespace.orgId, providerConfig),
      config: {
        bindingName: providerConfig.r2Binding.bindingName,
        orgPrefix: namespace.orgPrefix,
        storageKeyPrefix,
        storageKeySuffix: providerConfig.r2Binding.storageKeySuffix ?? null,
        limits: providerConfig.r2Binding.limits,
        createdAt: providerConfig.createdAt,
        updatedAt: providerConfig.updatedAt,
      },
    };
  }

  const storageKeyPrefix = resolveUploadStorageKeyPrefix(
    namespace.orgId,
    providerConfig.r2.storageKeySuffix,
  );
  return {
    provider: UPLOAD_PROVIDER_R2,
    configured: isProviderConfigConfigured(namespace.orgId, providerConfig),
    config: {
      bucket: providerConfig.r2.bucket,
      endpoint: providerConfig.r2.endpoint,
      pathStyle: providerConfig.r2.pathStyle,
      region: providerConfig.r2.signer.region,
      sessionTokenConfigured: Boolean(providerConfig.r2.signer.sessionToken),
      orgPrefix: namespace.orgPrefix,
      storageKeyPrefix,
      storageKeySuffix: providerConfig.r2.storageKeySuffix ?? null,
      limits: providerConfig.r2.limits,
      accessKeyIdPreview: maskSecret(providerConfig.r2.signer.accessKeyId),
      secretAccessKeyPreview: maskSecret(providerConfig.r2.signer.secretAccessKey),
      createdAt: providerConfig.createdAt,
      updatedAt: providerConfig.updatedAt,
    },
  };
};

export const buildUploadAdminConfigResponse = (
  config: StoredUploadAdminConfig | LegacyStoredUploadAdminConfig | null,
): UploadAdminConfigResponse => {
  const normalized = config ? normalizeStoredUploadAdminConfig(config) : null;
  if (!normalized) {
    return {
      configured: false,
      defaultProvider: null,
      providers: {},
    };
  }

  const providers: UploadAdminProviderMap = {};
  for (const provider of UPLOAD_PROVIDERS) {
    const providerConfig = normalized.providers[provider];
    if (!providerConfig) {
      continue;
    }
    const providerResponse = buildProviderResponse(normalized.namespace, providerConfig);
    if (provider === UPLOAD_PROVIDER_R2) {
      providers[UPLOAD_PROVIDER_R2] = providerResponse as UploadAdminProviderResponseR2;
    } else {
      providers[UPLOAD_PROVIDER_R2_BINDING] =
        providerResponse as UploadAdminProviderResponseR2Binding;
    }
  }

  const defaultProvider = resolveDefaultProvider(
    normalized.namespace.orgId,
    normalized.providers,
    normalized.defaultProvider,
  );

  return {
    configured: Boolean(defaultProvider && providers[defaultProvider]?.configured),
    defaultProvider,
    providers,
  };
};
