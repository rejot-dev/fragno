import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type BackofficeContextScope,
  backofficeContextScopeSchema,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { backofficeErrorMessage } from "./backoffice-error-message.js";

export type OAuthCredential = {
  clientId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
};

export type BackofficeCredential = {
  accessToken: string;
  expiresAt: string;
  scope: BackofficeContextScope;
};

/** One server's credentials, as the CLI uses them. */
export type StoredAuthState = {
  baseUrl: string;
  oauth: OAuthCredential;
  backoffice: BackofficeCredential;
};

const serverCredentialSchema = z.object({
  oauth: z.object({
    clientId: z.string(),
    accessToken: z.string(),
    accessTokenExpiresAt: z.string(),
    refreshToken: z.string(),
  }),
  backoffice: z.object({
    accessToken: z.string(),
    expiresAt: z.string(),
    scope: backofficeContextScopeSchema,
  }),
});
// Keyed by server origin, so signing in to one server keeps the others signed in.
const authFileSchema = z.object({ servers: z.record(z.string(), serverCredentialSchema) });
type AuthFile = z.infer<typeof authFileSchema>;

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const SQLITE_BUSY = 5;

export async function readStoredAuth(
  authFile: string,
  baseUrl: string,
): Promise<StoredAuthState | null> {
  const credential = (await readAuthFile(authFile)).servers[baseUrl];
  return credential ? { baseUrl, ...credential } : null;
}

/** Stores a new sign-in, replacing the server's previous credentials. */
export async function storeAuth(authFile: string, auth: StoredAuthState): Promise<void> {
  await withFileLock(authFile, async () => {
    await writeServerCredential(authFile, auth);
  });
}

/**
 * Stores a Backoffice token over the server's current credentials, which another process may have
 * refreshed since this one read them.
 */
export async function storeBackofficeCredential(
  authFile: string,
  auth: StoredAuthState,
): Promise<void> {
  await withFileLock(authFile, async () => {
    const current = await readStoredAuth(authFile, auth.baseUrl);
    await writeServerCredential(authFile, { ...(current ?? auth), backoffice: auth.backoffice });
  });
}

/**
 * Refreshes the OAuth credential `auth` was read with, unless another process already did.
 *
 * The server revokes every refresh token of the client when one is used twice, so refreshes are
 * serialized: a process that finds the stored refresh token changed since it read `auth` takes
 * the stored credential instead of spending the rotated token again.
 */
export async function refreshStoredOAuth(
  authFile: string,
  auth: StoredAuthState,
  refresh: (oauth: OAuthCredential) => Promise<OAuthCredential>,
): Promise<StoredAuthState> {
  return await withFileLock(authFile, async () => {
    const current = (await readStoredAuth(authFile, auth.baseUrl)) ?? auth;
    if (current.oauth.refreshToken !== auth.oauth.refreshToken) {
      return current;
    }
    const refreshed = { ...current, oauth: await refresh(current.oauth) };
    await writeServerCredential(authFile, refreshed);
    return refreshed;
  });
}

const pendingLoginFileSchema = z.object({
  servers: z.record(
    z.string(),
    z.object({
      clientId: z.string(),
      deviceCode: z.string(),
      intervalSeconds: z.number().nonnegative(),
      expiresAt: z.iso.datetime(),
    }),
  ),
});
type PendingLoginFile = z.infer<typeof pendingLoginFileSchema>;
// Stored separately from credentials so another process can resume the approval wait.
export type PendingDeviceAuthorization = PendingLoginFile["servers"][string];

export async function readPendingDeviceAuthorization(
  pendingLoginFile: string,
  baseUrl: string,
): Promise<PendingDeviceAuthorization | null> {
  return (await readPendingLoginFile(pendingLoginFile)).servers[baseUrl] ?? null;
}

/** Replaces the server's pending authorization, so only the latest requested code is awaited. */
export async function storePendingDeviceAuthorization(
  pendingLoginFile: string,
  baseUrl: string,
  authorization: PendingDeviceAuthorization,
): Promise<void> {
  await withFileLock(pendingLoginFile, async () => {
    const current = await readPendingLoginFile(pendingLoginFile);
    await writeStateFile(pendingLoginFile, {
      servers: { ...current.servers, [baseUrl]: authorization },
    });
  });
}

/** Removes the server's pending authorization once its device code has been spent. */
export async function clearPendingDeviceAuthorization(
  pendingLoginFile: string,
  baseUrl: string,
  deviceCode: string,
): Promise<void> {
  await withFileLock(pendingLoginFile, async () => {
    const { servers } = await readPendingLoginFile(pendingLoginFile);
    // A newer `login --start` may have replaced the authorization this process waited for.
    if (servers[baseUrl]?.deviceCode !== deviceCode) {
      return;
    }
    const remaining = { ...servers };
    delete remaining[baseUrl];
    await writeStateFile(pendingLoginFile, { servers: remaining });
  });
}

async function readAuthFile(authFile: string): Promise<AuthFile> {
  return await readStateFile(authFile, authFileSchema, "Auth state");
}

async function readPendingLoginFile(pendingLoginFile: string): Promise<PendingLoginFile> {
  return await readStateFile(pendingLoginFile, pendingLoginFileSchema, "Pending login state");
}

async function readStateFile<T extends { servers: object }>(
  file: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return schema.parse({ servers: {} });
    }
    throw new Error(`Could not read ${label} from ${file}: ${backofficeErrorMessage(error)}`, {
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} in ${file} is not valid JSON: ${backofficeErrorMessage(error)}`, {
      cause: error,
    });
  }
  const state = schema.safeParse(parsed);
  if (!state.success) {
    throw new Error(`${label} in ${file} uses an unsupported format. Remove it and log in.`);
  }
  return state.data;
}

/** Callers hold the lock, so the file cannot change between this read and the rename. */
async function writeServerCredential(authFile: string, auth: StoredAuthState): Promise<void> {
  const { baseUrl, ...credential } = auth;
  const current = await readAuthFile(authFile);
  await writeStateFile(authFile, { servers: { ...current.servers, [baseUrl]: credential } });
}

async function writeStateFile(file: string, state: AuthFile | PendingLoginFile): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryFile, file);
  await chmod(file, 0o600);
}

/**
 * Runs `critical` while holding the lock on `file`.
 *
 * The lock is an exclusive SQLite transaction, which holds an OS file lock. A holder that is slow,
 * such as one waiting on a token request, keeps it; one that exits, however it exits, loses it
 * to the OS. So nothing has to guess whether a holder is still alive, and nothing deletes a lock.
 */
async function withFileLock<T>(file: string, critical: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true });
  const lock = new DatabaseSync(`${file}.lock`);
  try {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    // Polls instead of setting a busy timeout, which would block the event loop while waiting.
    while (!tryBeginExclusive(lock)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for another leyway command to finish with ${file}.`);
      }
      await new Promise((resolveWait) => {
        setTimeout(resolveWait, LOCK_RETRY_MS);
      });
    }
    try {
      return await critical();
    } finally {
      lock.exec("ROLLBACK");
    }
  } finally {
    lock.close();
  }
}

function tryBeginExclusive(lock: DatabaseSync): boolean {
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return true;
  } catch (error) {
    // Extended result codes keep the primary code in the low byte.
    if (
      error &&
      typeof error === "object" &&
      "errcode" in error &&
      typeof error.errcode === "number" &&
      (error.errcode & 0xff) === SQLITE_BUSY
    ) {
      return false;
    }
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
