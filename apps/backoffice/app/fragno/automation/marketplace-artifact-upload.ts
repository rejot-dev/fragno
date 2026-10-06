import type { PreparedFileWrite } from "@fragno-dev/upload/types";
import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import type { UploadRouteCaller } from "@/fragno/upload-server";

import {
  throwMarketplaceUploadRouteError,
  throwUnexpectedMarketplaceUploadResponse,
} from "./marketplace-upload-errors";

/** Prepared artifact upload transport is shared by release workflows and listing-root initialization. */
export async function createMarketplaceArtifactUpload({
  routes,
  file,
}: {
  routes: UploadRouteCaller;
  file: {
    fileKey: string;
    relativePath: string;
    sizeBytes: number;
    checksum: { algo: "sha256"; value: string };
  };
}): Promise<string> {
  const response = await routes("POST", "/uploads", {
    body: {
      provider: "database",
      fileKey: file.fileKey,
      filename: file.relativePath.split("/").at(-1)!,
      sizeBytes: file.sizeBytes,
      contentType: inferMarketplaceArtifactContentType(file.fileKey),
      checksum: file.checksum,
      publicationMode: "batch",
    },
  });
  if (response.type === "error") {
    throwMarketplaceUploadRouteError({
      operation: "Marketplace artifact upload creation",
      status: response.status,
      error: response.error,
    });
  }
  if (response.type !== "json" || response.status < 200 || response.status >= 300) {
    throwUnexpectedMarketplaceUploadResponse({
      operation: "Marketplace artifact upload creation",
      status: response.status,
    });
  }
  return response.data.uploadId;
}

/** Transfer is a separate retry boundary; prepared bytes remain invisible until batch commit. */
export async function transferMarketplaceArtifactUpload({
  routes,
  uploadId,
  content,
}: {
  routes: UploadRouteCaller;
  uploadId: string;
  content: Uint8Array;
}): Promise<PreparedFileWrite> {
  const response = await routes("PUT", "/uploads/:uploadId/content", {
    pathParams: { uploadId },
    query: { provider: "database" },
    headers: { "content-type": "application/octet-stream" },
    body: new Blob([Uint8Array.from(content)]),
  });
  if (response.type === "error") {
    throwMarketplaceUploadRouteError({
      operation: "Marketplace artifact upload transfer",
      status: response.status,
      error: response.error,
    });
  }
  if (response.type !== "json" || response.status < 200 || response.status >= 300) {
    throwUnexpectedMarketplaceUploadResponse({
      operation: "Marketplace artifact upload transfer",
      status: response.status,
    });
  }
  if (response.data.kind !== "prepared") {
    throw new NonRetryableError("Marketplace batch upload published before its atomic commit.");
  }
  return response.data.write;
}

function inferMarketplaceArtifactContentType(fileKey: string): string {
  if (/\.json$/iu.test(fileKey)) {
    return "application/json";
  }
  if (/\.(md|mdx)$/iu.test(fileKey)) {
    return "text/markdown";
  }
  if (/\.(txt|log)$/iu.test(fileKey)) {
    return "text/plain";
  }
  if (/\.(ts|tsx)$/iu.test(fileKey)) {
    return "text/typescript";
  }
  if (/\.js$/iu.test(fileKey)) {
    return "text/javascript";
  }
  if (/\.html?$/iu.test(fileKey)) {
    return "text/html";
  }
  if (/\.css$/iu.test(fileKey)) {
    return "text/css";
  }
  if (/\.ya?ml$/iu.test(fileKey)) {
    return "application/yaml";
  }
  if (/\.sh$/iu.test(fileKey)) {
    return "text/x-shellscript";
  }
  return "application/octet-stream";
}
