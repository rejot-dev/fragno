import { useEffect, useState, type FormEvent } from "react";
import {
  Form,
  useActionData,
  useNavigation,
  useOutletContext,
  type ActionFunctionArgs,
} from "react-router";

import { getUploadDurableObject } from "@/cloudflare/cloudflare-utils";
import { ByteUnitField, FormContainer, FormField, TimeUnitField } from "@/components/backoffice";
import { UPLOAD_R2_DEFAULT_BINDING_NAME, type UploadAdminSetConfigPayload } from "@/fragno/upload";

import {
  UploadProviderTabs,
  formatTimestamp,
  type UploadConfigState,
  type UploadConfigurableProvider,
  type UploadLayoutContext,
} from "./shared";

type UploadConfigActionData = {
  ok: boolean;
  message: string;
  configState?: UploadConfigState;
};

type UploadLimitPayloadField =
  | "directUploadThresholdBytes"
  | "multipartThresholdBytes"
  | "multipartPartSizeBytes"
  | "uploadExpiresInSeconds"
  | "signedUrlExpiresInSeconds"
  | "maxSingleUploadBytes"
  | "maxMultipartUploadBytes"
  | "maxMetadataBytes";

type UploadConfigForm = {
  provider: UploadConfigurableProvider;
  defaultProvider: UploadConfigurableProvider;
  bindingName: string;
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken: string;
  pathStyle: boolean;
  storageKeySuffix: string;
  directUploadThresholdBytes: string;
  multipartThresholdBytes: string;
  multipartPartSizeBytes: string;
  uploadExpiresInSeconds: string;
  signedUrlExpiresInSeconds: string;
  maxSingleUploadBytes: string;
  maxMultipartUploadBytes: string;
  maxMetadataBytes: string;
};

const BYTES_IN_MIB = 1024 * 1024;
const BYTES_IN_GIB = 1024 * BYTES_IN_MIB;
const BYTES_IN_TIB = 1024 * BYTES_IN_GIB;

const HARDCODED_R2_BINDINGS = [UPLOAD_R2_DEFAULT_BINDING_NAME] as const;
const DEFAULT_UPLOAD_BINDING_NAME = HARDCODED_R2_BINDINGS[0];
const HARDCODED_R2_BINDING_SET = new Set<string>(HARDCODED_R2_BINDINGS);
const DEFAULT_LIMIT_VALUES: Record<UploadLimitPayloadField, string> = {
  directUploadThresholdBytes: String(5 * BYTES_IN_GIB),
  multipartThresholdBytes: String(5 * BYTES_IN_GIB),
  multipartPartSizeBytes: String(8 * BYTES_IN_MIB),
  uploadExpiresInSeconds: String(60 * 60),
  signedUrlExpiresInSeconds: String(60 * 60),
  maxSingleUploadBytes: String(5 * BYTES_IN_GIB),
  maxMultipartUploadBytes: String(5 * BYTES_IN_TIB),
  maxMetadataBytes: String(8_192),
};

const toProviderLabel = (provider: UploadConfigurableProvider) =>
  provider === "r2-binding" ? "R2 binding" : "R2 credentials";

const resolveAllowedBindingName = (value?: string | null) => {
  if (!value) {
    return DEFAULT_UPLOAD_BINDING_NAME;
  }

  return HARDCODED_R2_BINDING_SET.has(value) ? value : DEFAULT_UPLOAD_BINDING_NAME;
};

const isValidHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const validateBucket = (value: string) => {
  if (value.length < 3 || value.length > 63) {
    return "Bucket must be between 3 and 63 characters.";
  }

  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    return "Bucket must use lowercase letters, numbers, dots, and hyphens.";
  }

  if (value.includes("..") || value.includes(".-") || value.includes("-.")) {
    return "Bucket has an invalid dot or hyphen sequence.";
  }

  return null;
};

const parseLimitField = (
  value: string,
  label: string,
  options: { allowZero: boolean },
): { ok: true; value?: number | null } | { ok: false; message: string } => {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true };
  }

  if (trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "clear") {
    return { ok: true, value: null };
  }

  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: `${label} must be an integer.` };
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, message: `${label} must be an integer.` };
  }

  if (options.allowZero ? parsed < 0 : parsed <= 0) {
    return {
      ok: false,
      message: options.allowZero
        ? `${label} must be zero or a positive integer.`
        : `${label} must be a positive integer.`,
    };
  }

  return {
    ok: true,
    value: parsed,
  };
};

const toInputValue = (value?: number, fallback = "") =>
  typeof value === "number" ? String(value) : fallback;

const getProviderFormValues = (
  configState: UploadConfigState | null,
  provider: UploadConfigurableProvider,
): Partial<UploadConfigForm> => {
  if (provider === "r2") {
    const config = configState?.providers.r2?.config;
    return {
      bucket: config?.bucket ?? "",
      endpoint: config?.endpoint ?? "",
      region: config?.region ?? "auto",
      pathStyle: config?.pathStyle ?? true,
      storageKeySuffix: config?.storageKeySuffix ?? "",
      directUploadThresholdBytes: toInputValue(
        config?.limits?.directUploadThresholdBytes,
        DEFAULT_LIMIT_VALUES.directUploadThresholdBytes,
      ),
      multipartThresholdBytes: toInputValue(
        config?.limits?.multipartThresholdBytes,
        DEFAULT_LIMIT_VALUES.multipartThresholdBytes,
      ),
      multipartPartSizeBytes: toInputValue(
        config?.limits?.multipartPartSizeBytes,
        DEFAULT_LIMIT_VALUES.multipartPartSizeBytes,
      ),
      uploadExpiresInSeconds: toInputValue(
        config?.limits?.uploadExpiresInSeconds,
        DEFAULT_LIMIT_VALUES.uploadExpiresInSeconds,
      ),
      signedUrlExpiresInSeconds: toInputValue(
        config?.limits?.signedUrlExpiresInSeconds,
        DEFAULT_LIMIT_VALUES.signedUrlExpiresInSeconds,
      ),
      maxSingleUploadBytes: toInputValue(
        config?.limits?.maxSingleUploadBytes,
        DEFAULT_LIMIT_VALUES.maxSingleUploadBytes,
      ),
      maxMultipartUploadBytes: toInputValue(
        config?.limits?.maxMultipartUploadBytes,
        DEFAULT_LIMIT_VALUES.maxMultipartUploadBytes,
      ),
      maxMetadataBytes: toInputValue(
        config?.limits?.maxMetadataBytes,
        DEFAULT_LIMIT_VALUES.maxMetadataBytes,
      ),
    };
  }

  const config = configState?.providers["r2-binding"]?.config;
  return {
    bindingName: resolveAllowedBindingName(config?.bindingName ?? DEFAULT_UPLOAD_BINDING_NAME),
    storageKeySuffix: config?.storageKeySuffix ?? "",
    directUploadThresholdBytes: toInputValue(
      config?.limits?.directUploadThresholdBytes,
      DEFAULT_LIMIT_VALUES.directUploadThresholdBytes,
    ),
    multipartThresholdBytes: toInputValue(
      config?.limits?.multipartThresholdBytes,
      DEFAULT_LIMIT_VALUES.multipartThresholdBytes,
    ),
    multipartPartSizeBytes: toInputValue(
      config?.limits?.multipartPartSizeBytes,
      DEFAULT_LIMIT_VALUES.multipartPartSizeBytes,
    ),
    uploadExpiresInSeconds: toInputValue(
      config?.limits?.uploadExpiresInSeconds,
      DEFAULT_LIMIT_VALUES.uploadExpiresInSeconds,
    ),
    signedUrlExpiresInSeconds: toInputValue(
      config?.limits?.signedUrlExpiresInSeconds,
      DEFAULT_LIMIT_VALUES.signedUrlExpiresInSeconds,
    ),
    maxSingleUploadBytes: toInputValue(
      config?.limits?.maxSingleUploadBytes,
      DEFAULT_LIMIT_VALUES.maxSingleUploadBytes,
    ),
    maxMultipartUploadBytes: toInputValue(
      config?.limits?.maxMultipartUploadBytes,
      DEFAULT_LIMIT_VALUES.maxMultipartUploadBytes,
    ),
    maxMetadataBytes: toInputValue(
      config?.limits?.maxMetadataBytes,
      DEFAULT_LIMIT_VALUES.maxMetadataBytes,
    ),
  };
};

const normalizeUploadConfigInput = (
  input: UploadConfigForm,
):
  | { ok: true; payload: UploadAdminSetConfigPayload }
  | {
      ok: false;
      message: string;
    } => {
  const provider = input.provider === "r2" ? "r2" : "r2-binding";
  const defaultProvider = provider;
  const bindingName = input.bindingName.trim();
  const bucket = input.bucket.trim();
  const endpoint = input.endpoint.trim();
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  const region = input.region.trim() || "auto";
  const sessionToken = input.sessionToken.trim();
  const storageKeySuffix = input.storageKeySuffix.trim();

  const limitFields: {
    key: UploadLimitPayloadField;
    label: string;
    value: string;
    allowZero: boolean;
  }[] = [
    {
      key: "directUploadThresholdBytes",
      label: "Direct upload threshold",
      value: input.directUploadThresholdBytes,
      allowZero: false,
    },
    {
      key: "multipartThresholdBytes",
      label: "Multipart threshold",
      value: input.multipartThresholdBytes,
      allowZero: false,
    },
    {
      key: "multipartPartSizeBytes",
      label: "Multipart part size",
      value: input.multipartPartSizeBytes,
      allowZero: false,
    },
    {
      key: "uploadExpiresInSeconds",
      label: "Upload expiry",
      value: input.uploadExpiresInSeconds,
      allowZero: false,
    },
    {
      key: "signedUrlExpiresInSeconds",
      label: "Signed URL expiry",
      value: input.signedUrlExpiresInSeconds,
      allowZero: false,
    },
    {
      key: "maxSingleUploadBytes",
      label: "Max single upload bytes",
      value: input.maxSingleUploadBytes,
      allowZero: false,
    },
    {
      key: "maxMultipartUploadBytes",
      label: "Max multipart upload bytes",
      value: input.maxMultipartUploadBytes,
      allowZero: false,
    },
    {
      key: "maxMetadataBytes",
      label: "Max metadata bytes",
      value: input.maxMetadataBytes,
      allowZero: true,
    },
  ];

  const payload: UploadAdminSetConfigPayload = {
    provider,
    defaultProvider,
    storageKeySuffix: storageKeySuffix || null,
  };

  if (provider === "r2-binding") {
    if (!bindingName) {
      return {
        ok: false,
        message: "Binding name is required for R2 binding mode.",
      };
    }
    if (!HARDCODED_R2_BINDING_SET.has(bindingName)) {
      return {
        ok: false,
        message: `Binding name must be one of: ${HARDCODED_R2_BINDINGS.join(", ")}.`,
      };
    }

    payload.bindingName = bindingName;
  } else {
    if (!bucket || !endpoint || !accessKeyId) {
      return {
        ok: false,
        message: "Bucket, endpoint, and access key id are required.",
      };
    }

    const bucketError = validateBucket(bucket);
    if (bucketError) {
      return { ok: false, message: bucketError };
    }

    if (!isValidHttpUrl(endpoint)) {
      return {
        ok: false,
        message: "Endpoint must include http:// or https://.",
      };
    }

    if (region.includes(" ")) {
      return {
        ok: false,
        message: "Region must not contain whitespace.",
      };
    }

    payload.bucket = bucket;
    payload.endpoint = endpoint;
    payload.accessKeyId = accessKeyId;
    payload.region = region;
    payload.pathStyle = input.pathStyle;
    payload.sessionToken = sessionToken || null;
    if (secretAccessKey) {
      payload.secretAccessKey = secretAccessKey;
    }
  }

  for (const field of limitFields) {
    const parsed = parseLimitField(field.value, field.label, {
      allowZero: field.allowZero,
    });
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value !== undefined) {
      payload[field.key] = parsed.value;
    }
  }

  return { ok: true, payload };
};

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };

  const formInput: UploadConfigForm = {
    provider: getValue("provider") === "r2" ? "r2" : "r2-binding",
    defaultProvider: getValue("defaultProvider") === "r2" ? "r2" : "r2-binding",
    bindingName: getValue("bindingName"),
    bucket: getValue("bucket"),
    endpoint: getValue("endpoint"),
    accessKeyId: getValue("accessKeyId"),
    secretAccessKey: getValue("secretAccessKey"),
    region: getValue("region"),
    sessionToken: getValue("sessionToken"),
    pathStyle: formData.get("pathStyle") === "on",
    storageKeySuffix: getValue("storageKeySuffix"),
    directUploadThresholdBytes: getValue("directUploadThresholdBytes"),
    multipartThresholdBytes: getValue("multipartThresholdBytes"),
    multipartPartSizeBytes: getValue("multipartPartSizeBytes"),
    uploadExpiresInSeconds: getValue("uploadExpiresInSeconds"),
    signedUrlExpiresInSeconds: getValue("signedUrlExpiresInSeconds"),
    maxSingleUploadBytes: getValue("maxSingleUploadBytes"),
    maxMultipartUploadBytes: getValue("maxMultipartUploadBytes"),
    maxMetadataBytes: getValue("maxMetadataBytes"),
  };

  const validation = normalizeUploadConfigInput(formInput);
  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
    } satisfies UploadConfigActionData;
  }

  const uploadDo = getUploadDurableObject(context, params.orgId);

  try {
    const configState = await uploadDo.setAdminConfig(validation.payload, params.orgId);
    return {
      ok: true,
      message: "Upload configuration saved.",
      configState,
    } satisfies UploadConfigActionData;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save configuration.",
    } satisfies UploadConfigActionData;
  }
}

export default function BackofficeOrganisationUploadConfiguration() {
  const { configState, configLoading, configError, setConfigError, setConfigState } =
    useOutletContext<UploadLayoutContext>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [localError, setLocalError] = useState<string | null>(null);
  const [formState, setFormState] = useState<UploadConfigForm>({
    provider: "r2-binding",
    defaultProvider: "r2-binding",
    bindingName: DEFAULT_UPLOAD_BINDING_NAME,
    bucket: "",
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
    region: "auto",
    sessionToken: "",
    pathStyle: true,
    storageKeySuffix: "",
    directUploadThresholdBytes: DEFAULT_LIMIT_VALUES.directUploadThresholdBytes,
    multipartThresholdBytes: DEFAULT_LIMIT_VALUES.multipartThresholdBytes,
    multipartPartSizeBytes: DEFAULT_LIMIT_VALUES.multipartPartSizeBytes,
    uploadExpiresInSeconds: DEFAULT_LIMIT_VALUES.uploadExpiresInSeconds,
    signedUrlExpiresInSeconds: DEFAULT_LIMIT_VALUES.signedUrlExpiresInSeconds,
    maxSingleUploadBytes: DEFAULT_LIMIT_VALUES.maxSingleUploadBytes,
    maxMultipartUploadBytes: DEFAULT_LIMIT_VALUES.maxMultipartUploadBytes,
    maxMetadataBytes: DEFAULT_LIMIT_VALUES.maxMetadataBytes,
  });

  useEffect(() => {
    if (!configState) {
      return;
    }

    setFormState((prev) => {
      const nextProvider = configState.defaultProvider ?? prev.provider;
      return {
        ...prev,
        provider: nextProvider,
        defaultProvider: nextProvider,
        ...getProviderFormValues(configState, nextProvider),
        bindingName:
          configState.providers["r2-binding"]?.config?.bindingName ??
          resolveAllowedBindingName(prev.bindingName),
        secretAccessKey: "",
        sessionToken: "",
      };
    });
  }, [configState]);

  useEffect(() => {
    if (!actionData?.configState) {
      return;
    }

    setConfigState(actionData.configState);
    setConfigError(null);
    if (actionData.ok) {
      setFormState((prev) => ({
        ...prev,
        secretAccessKey: "",
        sessionToken: "",
      }));
    }
  }, [actionData, setConfigError, setConfigState]);

  const saveError = localError ?? (actionData && !actionData.ok ? actionData.message : null);
  const saveSuccess = !localError && actionData?.ok ? actionData.message : null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    setLocalError(null);

    const validation = normalizeUploadConfigInput(formState);
    if (!validation.ok) {
      setLocalError(validation.message);
      event.preventDefault();
    }
  };

  const statusLabel = configState?.configured ? "Configured" : "Not configured";
  const statusTone = configState?.configured
    ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
    : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)]";
  const configuredProviders = (["r2-binding", "r2"] as const).filter(
    (provider) => configState?.providers[provider]?.configured,
  );
  const activeProviderConfig = configState?.providers[formState.provider]?.config;
  const r2Config = configState?.providers.r2?.config;

  return (
    <div className="space-y-4">
      <UploadProviderTabs
        activeProvider={formState.provider}
        onSelect={(provider) =>
          setFormState((prev) => ({
            ...prev,
            provider,
            defaultProvider: provider,
            ...getProviderFormValues(configState ?? null, provider),
            bindingName:
              provider === "r2-binding"
                ? resolveAllowedBindingName(
                    configState?.providers["r2-binding"]?.config?.bindingName ?? prev.bindingName,
                  )
                : prev.bindingName,
            secretAccessKey: "",
            sessionToken: "",
          }))
        }
      />

      <section className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                Status
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Upload storage</h2>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Upload storage is scoped per organisation with a mandatory org storage prefix.
              </p>
            </div>
            <span
              className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${statusTone}`}
            >
              {statusLabel}
            </span>
          </div>

          <div className="mt-4 space-y-2 text-sm text-[var(--bo-muted)]">
            {configLoading ? (
              <p>Loading configuration…</p>
            ) : configError ? (
              <p className="text-red-500">{configError}</p>
            ) : configuredProviders.length > 0 ? (
              <>
                <p>
                  Configured providers:{" "}
                  <span className="text-[var(--bo-fg)]">
                    {configuredProviders.map((provider) => toProviderLabel(provider)).join(", ")}
                  </span>
                </p>
                {activeProviderConfig?.storageKeyPrefix ? (
                  <p>
                    Active namespace:{" "}
                    <span className="text-[var(--bo-fg)]">
                      {activeProviderConfig.storageKeyPrefix}
                    </span>
                  </p>
                ) : null}
                <p>
                  Last updated:{" "}
                  <span className="text-[var(--bo-fg)]">
                    {formatTimestamp(activeProviderConfig?.updatedAt)}
                  </span>
                </p>
                {r2Config?.accessKeyIdPreview ? (
                  <p>
                    R2 access key:{" "}
                    <span className="text-[var(--bo-fg)]">{r2Config.accessKeyIdPreview}</span>
                  </p>
                ) : null}
                {r2Config?.secretAccessKeyPreview ? (
                  <p>
                    R2 secret key:{" "}
                    <span className="text-[var(--bo-fg)]">{r2Config.secretAccessKeyPreview}</span>
                  </p>
                ) : null}
              </>
            ) : (
              <p>Configure at least one provider to enable upload and file operations.</p>
            )}
          </div>
        </div>

        <FormContainer
          title="Provider status"
          eyebrow="Scope"
          description="R2 binding and R2 credentials can be configured side-by-side. Saving the active tab also makes it the default provider."
        >
          <div className="space-y-2 text-sm text-[var(--bo-muted)]">
            <p>
              Active editor tab:{" "}
              <span className="text-[var(--bo-fg)]">{toProviderLabel(formState.provider)}</span>
            </p>
            {(configuredProviders.length > 0
              ? configuredProviders
              : (["r2-binding", "r2"] as const)
            ).map((provider) => {
              const providerState = configState?.providers[provider];
              return (
                <p key={provider}>
                  {toProviderLabel(provider)}:{" "}
                  <span className="text-[var(--bo-fg)]">
                    {providerState?.configured ? "Configured" : "Not configured"}
                  </span>
                  {providerState?.config?.storageKeyPrefix ? (
                    <>
                      {" "}
                      ·{" "}
                      <span className="text-[var(--bo-fg)]">
                        {providerState.config.storageKeyPrefix}
                      </span>
                    </>
                  ) : null}
                </p>
              );
            })}
            <p>
              Org prefix:{" "}
              <span className="text-[var(--bo-fg)]">
                {activeProviderConfig?.orgPrefix ?? "org/<organisation-id>"}
              </span>
            </p>
          </div>
        </FormContainer>
      </section>

      <div className="max-w-full lg:max-w-[50%]">
        <FormContainer
          title="Upload configuration"
          eyebrow="Provider"
          description="Use the provider tabs above to edit one provider at a time. Saving a tab also sets it as the default provider."
        >
          <Form method="post" className="space-y-3" onSubmit={handleSubmit}>
            <input type="hidden" name="provider" value={formState.provider} />
            <input type="hidden" name="defaultProvider" value={formState.provider} />
            <input type="hidden" name="bindingName" value={formState.bindingName} />

            {formState.provider === "r2-binding" ? (
              <div className="rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Hardcoded binding
                </p>
                <p className="mt-2">
                  Active binding:{" "}
                  <span className="text-[var(--bo-fg)]">{formState.bindingName}</span>
                </p>
                <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                  Available bindings: {HARDCODED_R2_BINDINGS.join(", ")}
                </p>
              </div>
            ) : null}

            {formState.provider === "r2" ? (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <FormField label="Bucket" hint="Lowercase bucket name.">
                    <input
                      name="bucket"
                      required={formState.provider === "r2"}
                      value={formState.bucket}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, bucket: event.target.value }))
                      }
                      placeholder="acme-upload-bucket"
                      className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                    />
                  </FormField>
                  <FormField label="Endpoint" hint="R2 S3 endpoint.">
                    <input
                      name="endpoint"
                      required={formState.provider === "r2"}
                      value={formState.endpoint}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, endpoint: event.target.value }))
                      }
                      placeholder="https://<account>.r2.cloudflarestorage.com"
                      className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                    />
                  </FormField>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <FormField label="Access key id" hint="Required.">
                    <input
                      name="accessKeyId"
                      required={formState.provider === "r2"}
                      value={formState.accessKeyId}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, accessKeyId: event.target.value }))
                      }
                      placeholder={r2Config?.accessKeyIdPreview || "AKIA..."}
                      className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                    />
                  </FormField>
                  <FormField label="Secret access key" hint="Leave blank to keep current secret.">
                    <input
                      name="secretAccessKey"
                      type="password"
                      value={formState.secretAccessKey}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, secretAccessKey: event.target.value }))
                      }
                      placeholder={r2Config?.secretAccessKeyPreview || "••••••••"}
                      className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                    />
                  </FormField>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <FormField label="Region" hint="Usually auto for R2.">
                    <input
                      name="region"
                      value={formState.region}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, region: event.target.value }))
                      }
                      placeholder="auto"
                      className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                    />
                  </FormField>
                  <FormField label="Session token" hint="Optional.">
                    <input
                      name="sessionToken"
                      value={formState.sessionToken}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, sessionToken: event.target.value }))
                      }
                      placeholder="Optional session token"
                      className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
                    />
                  </FormField>
                </div>

                <label className="inline-flex items-center gap-2 text-sm text-[var(--bo-muted)]">
                  <input
                    name="pathStyle"
                    type="checkbox"
                    checked={formState.pathStyle}
                    onChange={(event) =>
                      setFormState((prev) => ({ ...prev, pathStyle: event.target.checked }))
                    }
                    className="h-4 w-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
                  />
                  Use path-style addressing
                </label>
              </>
            ) : (
              <div className="rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
                R2 binding mode uses the Worker binding directly, so endpoint and credentials are
                not required.
              </div>
            )}

            <FormField label="Storage suffix" hint="Optional suffix under org prefix.">
              <input
                name="storageKeySuffix"
                value={formState.storageKeySuffix}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, storageKeySuffix: event.target.value }))
                }
                placeholder="uploads"
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/20 focus:outline-none"
              />
            </FormField>

            <details className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
              <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                Advanced limits and expiry
              </summary>
              <div className="space-y-3 border-t border-[color:var(--bo-border)] p-3">
                <p className="text-xs text-[var(--bo-muted)]">
                  Defaults are prefilled for reference. Update only if your organisation needs
                  custom limits.
                </p>

                <div className="grid gap-3 md:grid-cols-2">
                  <ByteUnitField
                    label="Direct threshold"
                    name="directUploadThresholdBytes"
                    value={formState.directUploadThresholdBytes}
                    onChange={(directUploadThresholdBytes) =>
                      setFormState((prev) => ({
                        ...prev,
                        directUploadThresholdBytes,
                      }))
                    }
                  />
                  <ByteUnitField
                    label="Multipart threshold"
                    name="multipartThresholdBytes"
                    value={formState.multipartThresholdBytes}
                    onChange={(multipartThresholdBytes) =>
                      setFormState((prev) => ({
                        ...prev,
                        multipartThresholdBytes,
                      }))
                    }
                  />
                  <ByteUnitField
                    label="Multipart part size"
                    name="multipartPartSizeBytes"
                    value={formState.multipartPartSizeBytes}
                    onChange={(multipartPartSizeBytes) =>
                      setFormState((prev) => ({
                        ...prev,
                        multipartPartSizeBytes,
                      }))
                    }
                  />
                  <TimeUnitField
                    label="Upload expiry"
                    name="uploadExpiresInSeconds"
                    value={formState.uploadExpiresInSeconds}
                    onChange={(uploadExpiresInSeconds) =>
                      setFormState((prev) => ({
                        ...prev,
                        uploadExpiresInSeconds,
                      }))
                    }
                  />
                  <TimeUnitField
                    label="Signed URL expiry"
                    name="signedUrlExpiresInSeconds"
                    value={formState.signedUrlExpiresInSeconds}
                    onChange={(signedUrlExpiresInSeconds) =>
                      setFormState((prev) => ({
                        ...prev,
                        signedUrlExpiresInSeconds,
                      }))
                    }
                  />
                  <ByteUnitField
                    label="Max single upload"
                    name="maxSingleUploadBytes"
                    value={formState.maxSingleUploadBytes}
                    onChange={(maxSingleUploadBytes) =>
                      setFormState((prev) => ({
                        ...prev,
                        maxSingleUploadBytes,
                      }))
                    }
                  />
                  <ByteUnitField
                    label="Max multipart upload"
                    name="maxMultipartUploadBytes"
                    value={formState.maxMultipartUploadBytes}
                    onChange={(maxMultipartUploadBytes) =>
                      setFormState((prev) => ({
                        ...prev,
                        maxMultipartUploadBytes,
                      }))
                    }
                  />
                  <ByteUnitField
                    label="Max metadata"
                    hint="Can be zero."
                    name="maxMetadataBytes"
                    value={formState.maxMetadataBytes}
                    onChange={(maxMetadataBytes) =>
                      setFormState((prev) => ({
                        ...prev,
                        maxMetadataBytes,
                      }))
                    }
                  />
                </div>
              </div>
            </details>

            {saveError ? <p className="text-xs text-red-500">{saveError}</p> : null}
            {saveSuccess ? <p className="text-xs text-green-500">{saveSuccess}</p> : null}

            <button
              type="submit"
              disabled={saving}
              className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save configuration"}
            </button>
          </Form>
        </FormContainer>
      </div>
    </div>
  );
}
