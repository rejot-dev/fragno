import {
  backofficeScopeJurisdiction,
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { AwsClient } from "aws4fetch";
import { z } from "zod";

import type { BlobsR2Access } from "@/fragno/blobs-r2-buckets";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";

import { siteBuildDirectory } from "./site-path";

/**
 * The build a site serves, with the fingerprint of the sources it was built from, and the builds
 * it replaced, each since when, which keep their files for requests that started before.
 */
export type SitePointer = {
  served: { build: string; sources: string };
  retired: { build: string; at: number }[];
};

/**
 * What a site's pointer says: no build yet, a pointer that does not parse, which only building the
 * site again repairs, or the builds it names. `revision` names the pointer a write may replace.
 */
export type SitePointerRead =
  | { status: "none" }
  | { status: "unreadable"; message: string; revision: string }
  | { status: "built"; pointer: SitePointer; revision: string };

/**
 * One site's builds and the pointer to the one it serves. A build is a set of files under an id of
 * its own, written once and never changed; only the pointer changes.
 */
export type SiteStore = {
  readPointer(): Promise<SitePointerRead>;
  /**
   * Replaces the pointer if it is still the revision read, or creates it if `expected` is null,
   * and reports a conflict otherwise. The workspace cannot compare, so there the write always wins.
   */
  writePointer(pointer: SitePointer, expected: string | null): Promise<"written" | "conflict">;
  writeFile(
    build: string,
    file: string,
    content: string | Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<void>;
  /** The file's bytes, or null when the build holds no such file. */
  readFile(build: string, file: string): Promise<BodyInit | null>;
  /** Removes the build, whose files the caller lists. */
  removeBuild(build: string, files: readonly string[]): Promise<void>;
};

// In the workspace, anyone who may write files may edit the pointer, so it is read as input.
const sitePointerFileSchema = z.strictObject({
  version: z.literal(5),
  served: z.strictObject({ build: z.uuid(), sources: z.string().regex(/^[0-9a-f]{64}$/u) }),
  retired: z.array(z.strictObject({ build: z.uuid(), at: z.number().int() })),
});

const POINTER_FILE = "build.json";

/**
 * Where a site's builds live: in the scope's R2 bucket wherever the deployment has buckets, and in
 * the workspace's `.build` otherwise. Each Worker of a deployment must agree, so both need the
 * buckets' credentials.
 */
export function siteStore({
  siteStorage,
  state,
  scope,
  sitePath,
}: {
  siteStorage: BlobsR2Access | null;
  state: BackofficeStateBackend;
  scope: BackofficeContextScope;
  sitePath: string;
}): SiteStore {
  return siteStorage
    ? r2SiteStore(siteStorage, scope, sitePath)
    : workspaceSiteStore(state, sitePath);
}

function parsePointer(path: string, text: string, revision: string): SitePointerRead {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch (error) {
    return { status: "unreadable", message: `${path} is not JSON: ${String(error)}`, revision };
  }
  const parsed = sitePointerFileSchema.safeParse(file);
  if (!parsed.success) {
    const message = `${path} is not a site build: ${parsed.error.message}`;
    return { status: "unreadable", message, revision };
  }
  const { served, retired } = parsed.data;
  return { status: "built", pointer: { served, retired }, revision };
}

function encodePointer(pointer: SitePointer): string {
  const file: z.input<typeof sitePointerFileSchema> = { version: 5, ...pointer };
  return JSON.stringify(file, null, 2);
}

function workspaceSiteStore(state: BackofficeStateBackend, sitePath: string): SiteStore {
  const directory = siteBuildDirectory(sitePath);
  const pointerPath = `${directory}/${POINTER_FILE}`;
  return {
    async readPointer() {
      // Builds re-read the pointer before replacing it, so they must see other runs' writes.
      state.refreshMetadata();
      if ((await state.stat(pointerPath))?.type !== "file") {
        return { status: "none" };
      }
      return parsePointer(pointerPath, await state.readFile(pointerPath), "");
    },
    async writePointer(pointer) {
      await state.writeFile(pointerPath, encodePointer(pointer));
      return "written";
    },
    async writeFile(build, file, content) {
      const path = `${directory}/${build}/${file}`;
      await (typeof content === "string"
        ? state.writeFile(path, content)
        : state.writeFileBytes(path, content));
    },
    async readFile(build, file) {
      const path = `${directory}/${build}/${file}`;
      return (await state.stat(path))?.type === "file" ? await state.readFileBytes(path) : null;
    },
    async removeBuild(build) {
      // Upload removes a folder only once it is empty; reversed, files precede their folders.
      for (const path of (await state.glob(`${directory}/${build}/**`)).reverse()) {
        await state.rm(path, { force: true });
      }
      await state.rm(`${directory}/${build}`, { force: true });
    },
  };
}

/**
 * Builds in the bucket of the scope's jurisdiction, under `sites/`, apart from the `org/` and
 * `named/` prefixes blobs use. Requests are signed for R2's S3 API, as blobs' are.
 */
function r2SiteStore(
  { buckets, fetch: send }: BlobsR2Access,
  scope: BackofficeContextScope,
  sitePath: string,
): SiteStore {
  const bucket = buckets[backofficeScopeJurisdiction(scope) ?? "none"];
  const client = new AwsClient({
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const site = ["sites", backofficeScopePathSegment(scope), ...sitePath.split("/").slice(2)];
  const objectUrl = (segments: readonly string[]) => {
    const url = new URL(bucket.endpoint);
    const base = url.pathname.replace(/^\/+|\/+$/g, "");
    const key = [...site, ...segments].map(encodeURIComponent);
    url.pathname = `/${[base, bucket.bucket, ...key].filter(Boolean).join("/")}`;
    return url.toString();
  };
  const request = async (
    method: "GET" | "PUT" | "DELETE",
    url: string,
    headers: Record<string, string>,
    body: BodyInit | null,
  ) => {
    // Signed without the body, which S3 then takes unhashed, so bytes are not read twice.
    const signed = await client.sign(url, { method, headers });
    return await send(signed.url, { method, headers: signed.headers, body });
  };
  const failed = (action: string, file: string, response: Response) =>
    new Error(`Could not ${action} ${file} of ${sitePath}: R2 answered ${response.status}.`);
  const pointerUrl = objectUrl([POINTER_FILE]);
  return {
    async readPointer() {
      const response = await request("GET", pointerUrl, {}, null);
      if (response.status === 404) {
        return { status: "none" };
      }
      if (!response.ok) {
        throw failed("read", POINTER_FILE, response);
      }
      // R2 returns an ETag on every object; a pointer without one could never be replaced.
      const revision = response.headers.get("etag") ?? "";
      return parsePointer(`${sitePath}'s ${POINTER_FILE}`, await response.text(), revision);
    },
    async writePointer(pointer, expected) {
      const condition: Record<string, string> =
        expected === null ? { "if-none-match": "*" } : { "if-match": expected };
      const response = await request(
        "PUT",
        pointerUrl,
        { "content-type": "application/json", ...condition },
        encodePointer(pointer),
      );
      if (response.status === 412) {
        return "conflict";
      }
      if (!response.ok) {
        throw failed("write", POINTER_FILE, response);
      }
      return "written";
    },
    async writeFile(build, file, content, contentType) {
      const url = objectUrl([build, ...file.split("/")]);
      const response = await request("PUT", url, { "content-type": contentType }, content);
      if (!response.ok) {
        throw failed("store", file, response);
      }
    },
    async readFile(build, file) {
      const response = await request("GET", objectUrl([build, ...file.split("/")]), {}, null);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw failed("read", file, response);
      }
      return response.body;
    },
    async removeBuild(build, files) {
      for (const file of files) {
        const url = objectUrl([build, ...file.split("/")]);
        const response = await request("DELETE", url, {}, null);
        if (!response.ok && response.status !== 404) {
          throw failed("remove", file, response);
        }
      }
    },
  };
}
