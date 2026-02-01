import path from "node:path";
import { migrate } from "@fragno-dev/db";
import {
  createFilesystemStorageAdapter,
  createS3CompatibleStorageAdapter,
  createUploadFragment,
  type UploadFragmentConfig,
} from "@fragno-dev/fragment-upload";

import { createUploadAdapter } from "./adapter.server";
import { createS3Signer } from "./s3-signer.server";

export type UploadServer = ReturnType<typeof createUploadFragment>;

export type UploadServers = {
  direct?: UploadServer;
  proxy: UploadServer;
  directError?: string;
};

let serverPromise: Promise<UploadServers> | null = null;

export function getUploadServers() {
  if (!serverPromise) {
    serverPromise = createServers().catch((error) => {
      serverPromise = null;
      throw error;
    });
  }
  return serverPromise;
}

const resolveS3Config = () => {
  const bucket = process.env.UPLOAD_S3_BUCKET;
  const endpoint = process.env.UPLOAD_S3_ENDPOINT;
  const region = process.env.UPLOAD_S3_REGION ?? "auto";
  const accessKeyId = process.env.UPLOAD_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.UPLOAD_S3_SECRET_ACCESS_KEY;
  const sessionToken = process.env.UPLOAD_S3_SESSION_TOKEN;
  const pathStyle = process.env.UPLOAD_S3_PATH_STYLE === "true";
  const multipartThresholdBytes = parseOptionalPositiveInt(
    process.env.UPLOAD_S3_MULTIPART_THRESHOLD_BYTES,
    "UPLOAD_S3_MULTIPART_THRESHOLD_BYTES",
  );
  const multipartPartSizeBytes = parseOptionalPositiveInt(
    process.env.UPLOAD_S3_MULTIPART_PART_SIZE_BYTES,
    "UPLOAD_S3_MULTIPART_PART_SIZE_BYTES",
  );
  const directUploadThresholdBytes = parseOptionalPositiveInt(
    process.env.UPLOAD_S3_DIRECT_UPLOAD_THRESHOLD_BYTES,
    "UPLOAD_S3_DIRECT_UPLOAD_THRESHOLD_BYTES",
  );
  const maxSingleUploadBytes = parseOptionalPositiveInt(
    process.env.UPLOAD_S3_MAX_SINGLE_UPLOAD_BYTES,
    "UPLOAD_S3_MAX_SINGLE_UPLOAD_BYTES",
  );
  const maxMultipartUploadBytes = parseOptionalPositiveInt(
    process.env.UPLOAD_S3_MAX_MULTIPART_UPLOAD_BYTES,
    "UPLOAD_S3_MAX_MULTIPART_UPLOAD_BYTES",
  );
  const uploadExpiresInSeconds = parseOptionalPositiveInt(
    process.env.UPLOAD_S3_UPLOAD_EXPIRES_IN_SECONDS,
    "UPLOAD_S3_UPLOAD_EXPIRES_IN_SECONDS",
  );
  const signedUrlExpiresInSeconds = parseOptionalPositiveInt(
    process.env.UPLOAD_S3_SIGNED_URL_EXPIRES_IN_SECONDS,
    "UPLOAD_S3_SIGNED_URL_EXPIRES_IN_SECONDS",
  );
  const maxMetadataBytes = parseOptionalNonNegativeInt(
    process.env.UPLOAD_S3_MAX_METADATA_BYTES,
    "UPLOAD_S3_MAX_METADATA_BYTES",
  );

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    pathStyle,
    multipartThresholdBytes,
    multipartPartSizeBytes,
    directUploadThresholdBytes,
    maxSingleUploadBytes,
    maxMultipartUploadBytes,
    uploadExpiresInSeconds,
    signedUrlExpiresInSeconds,
    maxMetadataBytes,
  };
};

const createDirectConfig = (): UploadFragmentConfig => {
  const s3 = resolveS3Config();
  if (!s3) {
    throw new Error("Direct upload requires S3-compatible environment variables.");
  }

  const signer = createS3Signer({
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    sessionToken: s3.sessionToken,
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    pathStyle: s3.pathStyle,
    storageKeyPrefix: "direct",
  });

  return {
    storage: createS3CompatibleStorageAdapter({
      bucket: s3.bucket,
      endpoint: s3.endpoint,
      signer,
      pathStyle: s3.pathStyle,
      storageKeyPrefix: "direct",
      multipartThresholdBytes: s3.multipartThresholdBytes,
      multipartPartSizeBytes: s3.multipartPartSizeBytes,
      directUploadThresholdBytes: s3.directUploadThresholdBytes,
      maxSingleUploadBytes: s3.maxSingleUploadBytes,
      maxMultipartUploadBytes: s3.maxMultipartUploadBytes,
      uploadExpiresInSeconds: s3.uploadExpiresInSeconds,
      signedUrlExpiresInSeconds: s3.signedUrlExpiresInSeconds,
      maxMetadataBytes: s3.maxMetadataBytes,
    }),
  };
};

const createProxyConfig = (): UploadFragmentConfig => {
  const rootDir =
    process.env.UPLOAD_PROXY_DIR ?? path.join(process.env.HOME ?? process.cwd(), ".fragno");
  const uploadExpiresInSeconds = parseOptionalPositiveInt(
    process.env.UPLOAD_PROXY_UPLOAD_EXPIRES_IN_SECONDS,
    "UPLOAD_PROXY_UPLOAD_EXPIRES_IN_SECONDS",
  );

  return {
    storage: createFilesystemStorageAdapter({
      rootDir: path.join(rootDir, "upload-example"),
      storageKeyPrefix: "proxy",
      uploadExpiresInSeconds,
    }),
  };
};

const createServers = async (): Promise<UploadServers> => {
  const adapter = createUploadAdapter();

  const proxy = createUploadFragment(createProxyConfig(), {
    databaseAdapter: adapter,
    mountRoute: "/api/uploads-proxy",
  });

  await migrate(proxy);

  let direct: UploadServer | undefined;
  let directError: string | undefined;

  try {
    direct = createUploadFragment(createDirectConfig(), {
      databaseAdapter: adapter,
      mountRoute: "/api/uploads-direct",
    });
  } catch (error) {
    directError = error instanceof Error ? error.message : "Direct upload not configured";
  }

  return { direct, proxy, directError };
};

const parseOptionalPositiveInt = (value: string | undefined, name: string) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const parseOptionalNonNegativeInt = (value: string | undefined, name: string) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
};
