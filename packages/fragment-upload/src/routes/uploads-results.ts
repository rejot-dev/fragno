import type { UploadFragmentResolvedConfig } from "../config";
import type { UploadSessionSnapshot } from "../services/upload-model";
import type { UploadStrategy } from "../types";

export type CreateUploadResult = {
  uploadId: string;
  fileKey: string;
  provider: string;
  status: "created" | "in_progress";
  strategy: UploadStrategy;
  publicationMode: UploadSessionSnapshot["publicationMode"];
  expiresAt: Date;
  upload: {
    mode: "single" | "multipart";
    transport: "direct" | "proxy";
    uploadUrl?: string;
    uploadHeaders?: Record<string, string>;
    partSizeBytes?: number;
    maxParts?: number;
    statusEndpoint: string;
    progressEndpoint: string;
    partsEndpoint?: string;
    partsCompleteEndpoint?: string;
    completeEndpoint: string;
    abortEndpoint: string;
    contentEndpoint?: string;
  };
};

type UploadSessionRouteDataInput = {
  uploadId: string;
  provider: string;
  strategy: UploadStrategy;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  partSizeBytes?: number;
};

function providerStickyUploadEndpoint(uploadId: string, provider: string, suffix = "") {
  const query = new URLSearchParams({ provider }).toString();
  return `/uploads/${uploadId}${suffix}?${query}`;
}

export function buildUploadSessionRouteData(
  storage: UploadFragmentResolvedConfig["storage"],
  input: UploadSessionRouteDataInput,
): Pick<CreateUploadResult, "provider" | "upload"> {
  const { uploadId, provider, strategy } = input;

  return {
    provider,
    upload: {
      mode: strategy === "direct-multipart" ? "multipart" : "single",
      transport: strategy === "proxy" ? "proxy" : "direct",
      uploadUrl: input.uploadUrl,
      uploadHeaders: input.uploadHeaders,
      partSizeBytes: input.partSizeBytes,
      maxParts: storage.limits?.maxMultipartParts,
      statusEndpoint: providerStickyUploadEndpoint(uploadId, provider),
      progressEndpoint: providerStickyUploadEndpoint(uploadId, provider, "/progress"),
      partsEndpoint:
        strategy === "direct-multipart"
          ? providerStickyUploadEndpoint(uploadId, provider, "/parts")
          : undefined,
      partsCompleteEndpoint:
        strategy === "direct-multipart"
          ? providerStickyUploadEndpoint(uploadId, provider, "/parts/complete")
          : undefined,
      completeEndpoint: providerStickyUploadEndpoint(uploadId, provider, "/complete"),
      abortEndpoint: providerStickyUploadEndpoint(uploadId, provider, "/abort"),
      contentEndpoint:
        strategy === "proxy"
          ? providerStickyUploadEndpoint(uploadId, provider, "/content")
          : undefined,
    },
  };
}

export function toCreateUploadResult(
  storage: UploadFragmentResolvedConfig["storage"],
  upload: UploadSessionSnapshot,
): CreateUploadResult {
  const uploadId = upload.id.toString();

  return {
    uploadId,
    fileKey: upload.key,
    ...buildUploadSessionRouteData(storage, {
      uploadId,
      provider: upload.provider,
      strategy: upload.strategy,
      uploadUrl: upload.uploadUrl ?? undefined,
      uploadHeaders: upload.uploadHeaders ?? undefined,
      partSizeBytes: upload.partSizeBytes ?? undefined,
    }),
    status: upload.status,
    strategy: upload.strategy,
    publicationMode: upload.publicationMode,
    expiresAt: upload.expiresAt,
  };
}
