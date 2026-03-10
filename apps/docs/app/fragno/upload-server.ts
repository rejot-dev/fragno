import { AwsClient } from "aws4fetch";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import {
  createR2BindingStorageAdapter,
  createR2StorageAdapter,
  createUploadFragment,
  resolveR2BindingBucket,
  type S3Signer,
  type S3SignerInput,
} from "@fragno-dev/upload";
import {
  UPLOAD_PROVIDER_R2,
  resolveUploadProviderStorageKeyPrefix,
  type StoredUploadAdminConfig,
  type UploadProvider,
  type UploadR2SignerConfig,
} from "./upload";

const toBody = (value: S3SignerInput["body"]): BodyInit | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  return value as unknown as BodyInit;
};

const toHeaderRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

const createR2Signer = (config: UploadR2SignerConfig): S3Signer => {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    service: "s3",
    region: config.region,
  });

  return {
    sign: async (input) => {
      const request = await client.sign(input.url, {
        method: input.method,
        headers: input.headers,
        body: toBody(input.body),
      });

      return {
        url: request.url,
        headers: toHeaderRecord(request.headers),
      };
    },
    presign: async (input) => {
      const url = new URL(input.url);
      if (typeof input.expiresInSeconds === "number" && Number.isFinite(input.expiresInSeconds)) {
        url.searchParams.set(
          "X-Amz-Expires",
          String(Math.max(1, Math.floor(input.expiresInSeconds))),
        );
      }

      const request = await client.sign(url.toString(), {
        method: input.method,
        headers: input.headers,
        body: toBody(input.body),
        aws: { signQuery: true },
      });

      const headers = toHeaderRecord(request.headers);
      return {
        url: request.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    },
  };
};

const withDefined = <T extends object, K extends keyof T>(source: T, keys: readonly K[]) =>
  keys.reduce<Partial<T>>((acc, key) => {
    const value = source[key];
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});

const getProviderConfig = (config: StoredUploadAdminConfig, provider: UploadProvider) => {
  const providerConfig = config.providers[provider];
  if (!providerConfig) {
    throw new Error(`Upload provider '${provider}' is not configured.`);
  }
  return providerConfig;
};

export function createUploadServerForProvider(
  config: StoredUploadAdminConfig,
  provider: UploadProvider,
  state: DurableObjectState,
  env: CloudflareEnv,
) {
  const providerConfig = getProviderConfig(config, provider);
  const limits =
    providerConfig.provider === UPLOAD_PROVIDER_R2
      ? (providerConfig.r2.limits ?? {})
      : (providerConfig.r2Binding.limits ?? {});
  const storageKeyPrefix = resolveUploadProviderStorageKeyPrefix(config, provider);

  const storage =
    providerConfig.provider === UPLOAD_PROVIDER_R2
      ? createR2StorageAdapter({
          bucket: providerConfig.r2.bucket,
          endpoint: providerConfig.r2.endpoint,
          pathStyle: providerConfig.r2.pathStyle,
          storageKeyPrefix,
          signer: createR2Signer(providerConfig.r2.signer),
          ...withDefined(limits, [
            "directUploadThresholdBytes",
            "multipartThresholdBytes",
            "multipartPartSizeBytes",
            "uploadExpiresInSeconds",
            "signedUrlExpiresInSeconds",
            "maxSingleUploadBytes",
            "maxMultipartUploadBytes",
            "maxMetadataBytes",
          ]),
        })
      : createR2BindingStorageAdapter({
          bucket: resolveR2BindingBucket(
            env as unknown as Record<string, unknown>,
            providerConfig.r2Binding.bindingName,
          ),
          storageKeyPrefix,
          ...withDefined(limits, [
            "directUploadThresholdBytes",
            "multipartThresholdBytes",
            "multipartPartSizeBytes",
            "uploadExpiresInSeconds",
            "signedUrlExpiresInSeconds",
            "maxSingleUploadBytes",
            "maxMultipartUploadBytes",
            "maxMetadataBytes",
          ]),
        });

  return createUploadFragment(
    {
      storage,
      ...withDefined(limits, [
        "directUploadThresholdBytes",
        "multipartThresholdBytes",
        "multipartPartSizeBytes",
        "uploadExpiresInSeconds",
        "signedUrlExpiresInSeconds",
        "maxSingleUploadBytes",
        "maxMultipartUploadBytes",
      ]),
    },
    {
      databaseAdapter: createAdapter(state),
      mountRoute: "/api/upload",
    },
  );
}

export function createUploadServer(
  config: StoredUploadAdminConfig,
  state: DurableObjectState,
  env: CloudflareEnv,
) {
  return createUploadServerForProvider(config, config.defaultProvider, state, env);
}

export type UploadFragment = ReturnType<typeof createUploadServerForProvider>;
