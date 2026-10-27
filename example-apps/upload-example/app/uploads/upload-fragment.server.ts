import { migrate } from "@fragno-dev/db";
import { createUploadFragment } from "@fragno-dev/upload";

import { createUploadAdapter } from "./adapter.server";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export type UploadServer = ReturnType<typeof createUploadFragment>;

let serverPromise: Promise<UploadServer> | null = null;

export function getUploadServer() {
  if (!serverPromise) {
    serverPromise = createServer().catch((error: unknown) => {
      serverPromise = null;
      throw error;
    });
  }
  return serverPromise;
}

async function createServer(): Promise<UploadServer> {
  const server = createUploadFragment(
    { maxFileBytes: parseMaxFileBytes(process.env.UPLOAD_MAX_FILE_BYTES) },
    { databaseAdapter: createUploadAdapter(), mountRoute: "/api/uploads" },
  );
  await migrate(server);
  return server;
}

function parseMaxFileBytes(value: string | undefined) {
  if (!value) {
    return DEFAULT_MAX_FILE_BYTES;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("UPLOAD_MAX_FILE_BYTES must be a positive integer");
  }
  return parsed;
}
