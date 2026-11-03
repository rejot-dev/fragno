import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { CODEMODE_WORKER_RUNTIME } from "@fragno-dev/codemode/execution/codemode-worker-bundle";

import { inferFileContentType } from "@/file-collection/file-content-type";
import type { BlobsR2Access } from "@/fragno/blobs-r2-buckets";
import { builtJavaScriptModuleSchema } from "@/fragno/codemode/built-javascript-module";
import type { CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import { buildBackofficeJavaScriptModule } from "@/fragno/codemode/compiled-module-execute";
import {
  readSavedModuleImports,
  SavedModuleImportError,
} from "@/fragno/codemode/saved-module-imports";
import {
  StateFileReadLimitError,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { sha256Hex } from "@/lib/crypto";

import {
  encodeSiteIndex,
  readSiteIndex,
  SITE_BUILD_LAYOUT,
  SITE_INDEX_FILE,
  SITE_WORKER_FILE,
  siteBuildFiles,
  siteObjectFile,
  type SiteIndex,
} from "./site-build.server";
import { sitePathProblem } from "./site-path";
import { siteStore, type SitePointer, type SiteStore } from "./site-store.server";
import { checkSiteWorker, siteWorkerEntry } from "./site-worker.server";

/** A rejected build names no site to build; a failed one leaves the site serving its last build. */
export type SiteBuildOutcome =
  | { kind: "rejected"; message: string }
  | { kind: "built" }
  | { kind: "failed"; message: string };

/** A file under the site's `public/`, as listed; its bytes are read only to copy it. */
type SiteFileSource = {
  workspacePath: string;
  path: string;
  contentType: string;
  size: number;
  modifiedAt: number;
};

/**
 * What one site may hold under `public/`. A build holds at most `SITE_FILES_AT_ONCE` files in
 * memory, but it runs in the Worker that serves Backoffice, so each build is bounded as a whole.
 */
const SITE_MAX_FILES = 1000;
const SITE_MAX_BYTES = 50 * 1024 * 1024;
const SITE_FILES_AT_ONCE = 8;

// A publish that keeps losing to other builds of the site gives up rather than spin.
const PUBLISH_ATTEMPTS = 5;

/**
 * How long a replaced build keeps its files. A site request reads the pointer once and the build's
 * files as its Worker asks for them, so a request that runs longer than this after a rebuild may
 * find them gone.
 */
const RETIRED_BUILD_KEPT_MS = 15 * 60 * 1000;

/**
 * Builds a site's `worker.js` and `public/` files into a build, kept with the site's pointer in
 * R2 where the deployment has buckets and in the workspace's `.build` otherwise, then serves it.
 * A failed build leaves the previous one serving, and sources that did not change since the
 * served build are not built again.
 */
export async function buildSite({
  state,
  codemode,
  workerLoader,
  siteStorage,
  scope,
  sitePath,
}: {
  state: BackofficeStateBackend;
  codemode: CodemodeRunner;
  workerLoader: WorkerLoader | null;
  siteStorage: BlobsR2Access | null;
  scope: BackofficeContextScope;
  sitePath: string;
}): Promise<SiteBuildOutcome> {
  const problem = sitePathProblem(sitePath);
  if (problem !== null) {
    return { kind: "rejected", message: problem };
  }
  if ((await state.stat(sitePath))?.type !== "directory") {
    return { kind: "rejected", message: `${sitePath} is not a directory; write its files first.` };
  }
  const worker = await readSiteWorkerSource(state, sitePath);
  if (worker.kind === "failed") {
    return worker;
  }
  const listed = await listSiteFiles(state, sitePath);
  if (listed.kind === "failed") {
    return listed;
  }
  const { files } = listed;
  if (worker.kind === "files only" && files.length === 0) {
    return {
      kind: "failed",
      message: `${sitePath} has neither a worker.js nor files under public/.`,
    };
  }
  const sources = await siteSourcesFingerprint(worker.modules, files);
  const store = siteStore({ siteStorage, state, scope, sitePath });
  const current = await store.readPointer();
  if (current.status === "built" && current.pointer.served.sources === sources) {
    return { kind: "built" };
  }
  if (!workerLoader) {
    return { kind: "failed", message: "This Backoffice runtime cannot run site Workers." };
  }
  const built = await buildBackofficeJavaScriptModule({
    entry: worker.entry,
    modules: worker.modules,
    dependencies: {},
    codemode,
  });
  if (built.status === "error") {
    return { kind: "failed", message: built.error };
  }
  const unusable = await checkSiteWorker(workerLoader, built.bundle);
  if (unusable !== null) {
    return { kind: "failed", message: unusable };
  }

  // Each build has an id of its own, even from sources built before, so retiring one build never
  // removes files that another build, of the same sources, is about to publish.
  const build = crypto.randomUUID();
  await store.writeFile(
    build,
    SITE_WORKER_FILE,
    JSON.stringify({
      format: builtJavaScriptModuleSchema.shape.format.value,
      bundle: built.bundle,
    }),
    "application/json",
  );
  const index: SiteIndex = { files: {} };
  const copied = await copySiteFiles(state, store, build, files, index);
  if (copied !== null) {
    // No pointer names the build, so no request reads what it wrote.
    await store.removeBuild(build, siteBuildFiles(index));
    return { kind: "failed", message: copied };
  }
  // Written after the files it lists, so a build with an index is complete.
  await store.writeFile(build, SITE_INDEX_FILE, encodeSiteIndex(index), "application/json");
  return await publishSiteBuild(store, sitePath, { build, sources });
}

/**
 * Points the site at a written build. The build it replaces, and every build replaced within
 * `RETIRED_BUILD_KEPT_MS`, keep their files for requests that read the pointer before; older ones
 * leave the pointer and are removed. In R2 the pointer changes only if no other build changed it
 * since it was read, and a build that loses that race publishes again over the winner, so
 * concurrent builds each publish, and only the build that took a retired one off the pointer
 * removes it.
 */
async function publishSiteBuild(
  store: SiteStore,
  sitePath: string,
  served: SitePointer["served"],
): Promise<SiteBuildOutcome> {
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    const current = await store.readPointer();
    const now = Date.now();
    const retired =
      current.status === "built"
        ? [...current.pointer.retired, { build: current.pointer.served.build, at: now }]
        : [];
    const kept = retired.filter(({ at }) => now - at < RETIRED_BUILD_KEPT_MS);
    const written = await store.writePointer(
      { served, retired: kept },
      current.status === "none" ? null : current.revision,
    );
    if (written === "conflict") {
      continue;
    }
    for (const { build } of retired.filter((entry) => !kept.includes(entry))) {
      await removeSiteBuild(store, build);
    }
    return { kind: "built" };
  }
  // No pointer names the build, so no request reads it.
  await removeSiteBuild(store, served.build);
  return {
    kind: "failed",
    message: `Other builds of ${sitePath} kept replacing it; build it again.`,
  };
}

async function removeSiteBuild(store: SiteStore, build: string) {
  await store.removeBuild(build, siteBuildFiles(await readSiteIndex(store, build)));
}

/**
 * The Worker's entry and every module it imports: the site's `worker.js` wrapped, or, for a site
 * of files only, the Worker that serves them.
 */
async function readSiteWorkerSource(
  state: BackofficeStateBackend,
  sitePath: string,
): Promise<
  | { kind: "worker.js" | "files only"; entry: string; modules: Record<string, string> }
  | { kind: "failed"; message: string }
> {
  const entry = `${sitePath}/worker.js`;
  if ((await state.stat(entry))?.type !== "file") {
    const main = siteWorkerEntry(sitePath, "files only");
    return { kind: "files only", entry: main.path, modules: { [main.path]: main.source } };
  }
  try {
    const { modules, packages } = await readSavedModuleImports({
      readFile: (path) => state.readFile(path),
      program: { kind: "file", path: entry },
    });
    if (packages.length > 0) {
      return {
        kind: "failed",
        message: `Site Workers import saved modules by path, not packages (${packages.join(", ")}).`,
      };
    }
    const main = siteWorkerEntry(sitePath, "worker.js");
    return {
      kind: "worker.js",
      entry: main.path,
      modules: { ...modules, [main.path]: main.source },
    };
  } catch (error) {
    if (!(error instanceof SavedModuleImportError)) {
      throw error;
    }
    return {
      kind: "failed",
      message: `${error.path ?? entry}:${error.line}:${error.column}: ${error.message}`,
    };
  }
}

/**
 * Every file under the site's `public/`, at the URL path it is served at, without reading any, so
 * a site over its limits fails before its bytes are read.
 */
async function listSiteFiles(
  state: BackofficeStateBackend,
  sitePath: string,
): Promise<{ kind: "listed"; files: SiteFileSource[] } | { kind: "failed"; message: string }> {
  const root = `${sitePath}/public`;
  const paths = await state.glob(`${root}/**`);
  const stats = await mapAtMost(paths, SITE_FILES_AT_ONCE, async (path) => await state.stat(path));
  const files: SiteFileSource[] = [];
  let bytes = 0;
  for (const [i, workspacePath] of paths.entries()) {
    const stat = stats[i];
    if (stat?.type !== "file") {
      continue;
    }
    bytes += stat.size;
    const contentType = inferFileContentType(workspacePath);
    files.push({
      workspacePath,
      path: workspacePath.slice(root.length),
      // Text without a declared charset would be decoded by the browser's guess.
      contentType: contentType.startsWith("text/") ? `${contentType}; charset=utf-8` : contentType,
      size: stat.size,
      modifiedAt: stat.mtime.getTime(),
    });
  }
  if (files.length > SITE_MAX_FILES) {
    return {
      kind: "failed",
      message: `${root} holds ${files.length} files; a site may serve at most ${SITE_MAX_FILES}.`,
    };
  }
  if (bytes > SITE_MAX_BYTES) {
    return {
      kind: "failed",
      message: `${root} holds ${bytes} bytes; a site may serve at most ${SITE_MAX_BYTES}.`,
    };
  }
  return { kind: "listed", files };
}

/**
 * Copies the listed files into the build, a few at a time, adding each to the index once it is
 * stored. Returns why it stopped, or null once every file is copied.
 */
async function copySiteFiles(
  state: BackofficeStateBackend,
  store: SiteStore,
  build: string,
  files: readonly SiteFileSource[],
  index: SiteIndex,
): Promise<string | null> {
  const changed: string[] = [];
  await mapAtMost(files, SITE_FILES_AT_ONCE, async (file) => {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      // Bounded by the listed size, so a file that grew since cannot take the build over its limit.
      bytes = await state.readFileBytes(file.workspacePath, file.size);
    } catch (error) {
      if (error instanceof StateFileReadLimitError) {
        changed.push(file.workspacePath);
        return;
      }
      throw error;
    }
    await store.writeFile(build, siteObjectFile(file.path), bytes, file.contentType);
    index.files[file.path] = { contentType: file.contentType, etag: await sha256Hex(bytes) };
  });
  return changed.length === 0
    ? null
    : `${changed.join(", ")} changed while ${files.length === 1 ? "it was" : "they were"} built; build the site again.`;
}

/** Runs `operation` on every item, at most `limit` at once, keeping the items' order. */
async function mapAtMost<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await operation(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/**
 * Fingerprints everything a build is made of, so sources that did not change are not built again.
 * It includes the Worker runtime because a stored bundle only loads on the runtime it was built
 * for, so a new runtime must rebuild it.
 */
async function siteSourcesFingerprint(
  modules: Record<string, string>,
  assets: readonly SiteFileSource[],
): Promise<string> {
  const inputs = JSON.stringify([
    SITE_BUILD_LAYOUT,
    CODEMODE_WORKER_RUNTIME,
    Object.entries(modules).sort(([left], [right]) => left.localeCompare(right)),
    // Sizes and modification times, not contents, so an unchanged site is not read: a file
    // written again with the same bytes builds the site again, which is harmless.
    assets.map(({ path, size, modifiedAt }) => [path, size, modifiedAt]),
  ]);
  return await sha256Hex(new TextEncoder().encode(inputs));
}
