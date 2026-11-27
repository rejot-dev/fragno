import { spawn } from "node:child_process";
import { constants, unwatchFile, watchFile } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  backofficeDevServerPort,
  backofficeInspectorPort,
} from "@rejot-dev/backoffice-local/dev-server-port";

const enableContainersFlag = "--containers";
const enableSourceMapsFlag = "--sourcemap";
const enableWorkersAiFlag = "--ai";
const enableContainers = process.argv.includes(enableContainersFlag);
const enableSourceMaps = process.argv.includes(enableSourceMapsFlag);
const enableWorkersAi = process.argv.includes(enableWorkersAiFlag);
const wrapperFlags = [enableContainersFlag, enableSourceMapsFlag, enableWorkersAiFlag];
const previewArgs = process.argv.slice(2).filter((argument) => !wrapperFlags.includes(argument));

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const viteConfigPath = path.join(appDirectory, "vite.config.ts");
const snapshotsDirectory = path.join(appDirectory, ".wrangler/preview");
// Vite listens on every interface inside a boxd VM, so its proxy can reach it (see vite.config.ts).
const publicHost = process.env.BOXD_VM_HOST ? "0.0.0.0" : "127.0.0.1";
const appPort = backofficeDevServerPort(appDirectory);
const inspectorPort = backofficeInspectorPort(appDirectory);

// vite.config.ts writes this marker once a build has finished, listing every file a preview serves.
const buildCompleteMarkerPath = path.join(appDirectory, "build/.build-complete");
// The bridge Worker hosts the Sandbox containers that the object Worker binds to.
const containerWorkerConfigPath = "dist/cf_sandbox_bridge/wrangler.json";
// Backoffice fails sandbox starts at once when told the bridge has no containers. Workers AI always
// runs on Cloudflare, which needs wrangler signed in to an account with a workers.dev subdomain, so
// its binding stays out unless `--ai` asks for it; Backoffice then reports Workers AI unavailable.
const backofficeWorkerConfigPaths = [
  "build/server/wrangler.json",
  "dist/rejot_backoffice/wrangler.json",
];
const configPatches = [
  {
    path: containerWorkerConfigPath,
    patch: (config) => ({
      ...config,
      dev: { ...config.dev, enable_containers: enableContainers },
      // Image paths are relative to the build output, which the snapshot moves.
      containers: config.containers.map((container) => ({
        ...container,
        images: Object.fromEntries(
          Object.entries(container.images).map(([name, image]) => [
            name,
            {
              ...image,
              dockerfile: path.resolve(
                appDirectory,
                path.dirname(containerWorkerConfigPath),
                image.dockerfile,
              ),
            },
          ]),
        ),
      })),
    }),
  },
  ...backofficeWorkerConfigPaths.map((configPath) => ({
    path: configPath,
    patch: (config) => ({
      ...config,
      vars: { ...config.vars, SANDBOX_CONTAINERS: String(enableContainers) },
      ai: enableWorkersAi ? config.ai : undefined,
    }),
  })),
];
// Preview reads each Worker's secrets from a .dev.vars beside its output config. Builds carry none,
// since Turbo shares them between machines, so the local files are copied into each snapshot. Every
// Backoffice Worker gets the whole file so local overrides apply uniformly.
const devVarsCopies = [
  ["../.dev.vars", "build/server/.dev.vars"],
  ["../.dev.vars", "dist/rejot_backoffice/.dev.vars"],
  ["../../cf-sandbox-bridge/.dev.vars", "dist/cf_sandbox_bridge/.dev.vars"],
].map(([source, target]) => ({ source: path.resolve(appDirectory, "scripts", source), target }));

let stopSignal = null;
const previews = new Set();

/**
 * Copies the current build output, so the next build cannot change what a running preview serves
 * and the preview's patches never reach the output Turbo caches. Copies are clones where the file
 * system supports them.
 */
async function snapshotBuild(snapshotDirectory) {
  const files = JSON.parse(await readFile(buildCompleteMarkerPath, "utf8"));
  const directories = new Set();
  for (const [file, size] of Object.entries(files)) {
    const snapshotFile = path.join(snapshotDirectory, file);
    const directory = path.dirname(snapshotFile);
    if (!directories.has(directory)) {
      await mkdir(directory, { recursive: true });
      directories.add(directory);
    }
    await copyFile(path.join(appDirectory, file), snapshotFile, constants.COPYFILE_FICLONE);
    // Turbo restores a cached build in place, so a file can still hold the previous build.
    if ((await stat(snapshotFile)).size !== size) {
      throw new Error(`${file} does not match the finished build yet.`);
    }
  }
  for (const { path: configPath, patch } of configPatches) {
    const snapshotConfigPath = path.join(snapshotDirectory, configPath);
    const config = JSON.parse(await readFile(snapshotConfigPath, "utf8"));
    await writeFile(snapshotConfigPath, JSON.stringify(patch(config)));
  }
  for (const { source, target } of devVarsCopies) {
    try {
      await copyFile(source, path.join(snapshotDirectory, target));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

/** Snapshots the build once its output holds every file the marker lists, for up to 10 seconds. */
async function snapshotFinishedBuild(snapshotDirectory) {
  for (let attempt = 0; attempt < 40 && !stopSignal; attempt += 1) {
    try {
      await snapshotBuild(snapshotDirectory);
      return true;
    } catch {
      await rm(snapshotDirectory, { recursive: true, force: true });
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
  return false;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Runs `vite preview` on a snapshot, on ports of its own until the proxy points at it. */
async function startPreview(snapshotDirectory) {
  const preview = {
    snapshotDirectory,
    appPort: await findFreePort(),
    inspectorPort: await findFreePort(),
  };
  const child = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      snapshotDirectory,
      "--config",
      viteConfigPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(preview.appPort),
      "--strictPort",
      ...previewArgs,
    ],
    {
      cwd: appDirectory,
      // Vite's CLI shortcuts would print the preview's own port, and previews overlap while one
      // replaces another.
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, BACKOFFICE_PREVIEW_INSPECTOR_PORT: String(preview.inspectorPort) },
    },
  );
  preview.child = child;
  preview.exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  previews.add(preview);
  return preview;
}

/** Resolves once the preview answers HTTP, or with its exit if it stops first. */
async function waitUntilServing(preview) {
  let exit = null;
  preview.exited.then((result) => {
    exit = result;
  });
  while (!exit && !stopSignal) {
    try {
      await fetch(`http://127.0.0.1:${preview.appPort}/`, { signal: AbortSignal.timeout(5_000) });
      return null;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  }
  return exit;
}

async function stopPreview(preview) {
  preview.child.kill("SIGTERM");
  await preview.exited;
  previews.delete(preview);
  await rm(preview.snapshotDirectory, { recursive: true, force: true });
}

let activePreview = null;

/** Forwards connections on a fixed port to whichever preview is active. */
function startProxy(host, port, targetPort) {
  const server = createServer((client) => {
    if (!activePreview) {
      client.destroy();
      return;
    }
    const upstream = createConnection(targetPort(activePreview), "127.0.0.1");
    client.pipe(upstream).pipe(client);
    client.on("error", () => {
      upstream.destroy();
    });
    upstream.on("error", () => {
      client.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}

let snapshotCount = 0;

/**
 * Serves the current build: starts a preview of it and switches the proxy over once it answers. The
 * previous preview keeps serving until then, so a restart costs no downtime.
 */
async function serveLatestBuild() {
  snapshotCount += 1;
  const snapshotDirectory = path.join(snapshotsDirectory, String(snapshotCount));
  if (!(await snapshotFinishedBuild(snapshotDirectory))) {
    // There is no build yet, or one that started meanwhile replaces the output. The marker of the
    // next build starts another attempt.
    console.log(
      activePreview
        ? "\nThe Backoffice build changed while copying it; the next build replaces the preview.\n"
        : "\nWaiting for the Backoffice build.\n",
    );
    return;
  }
  const preview = await startPreview(snapshotDirectory);
  const exit = await waitUntilServing(preview);
  if (stopSignal) {
    return;
  }
  if (exit) {
    previews.delete(preview);
    await rm(snapshotDirectory, { recursive: true, force: true });
    if (!activePreview) {
      await shutDown(null, exit.code ?? 1);
    }
    console.error("\nThe new Backoffice preview failed to start, keeping the current one.\n");
    return;
  }
  const previousPreview = activePreview;
  activePreview = preview;
  preview.exited.then(({ code, signal }) => {
    // The active preview stopping on its own ends the run, as a plain `vite preview` would.
    if (activePreview === preview && !stopSignal) {
      console.error(`\nBackoffice preview exited (${signal ?? code}).`);
      void shutDown(null, code ?? 1);
    }
  });
  console.log(
    `\nBackoffice preview serving the latest build at http://${publicHost}:${appPort}/\n`,
  );
  if (previousPreview) {
    await stopPreview(previousPreview);
  }
}

let proxies = [];
let buildWatcher = null;

async function shutDown(signal, exitCode) {
  if (stopSignal) {
    return;
  }
  stopSignal = signal ?? "SIGTERM";
  unwatchFile(buildCompleteMarkerPath);
  buildWatcher?.kill(stopSignal);
  for (const proxy of proxies) {
    proxy.close();
  }
  await Promise.all([...previews].map((preview) => stopPreview(preview)));
  await rm(snapshotsDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}

// Ctrl-C signals the whole process group. Without handlers Node exits at once and leaves the
// snapshots behind, so the wrapper stays up until every preview has shut down.
process.on("SIGINT", () => void shutDown("SIGINT", 0));
process.on("SIGTERM", () => void shutDown("SIGTERM", 0));

if (enableSourceMaps) {
  // Preview serves existing output, so source maps must be generated before it starts. The build
  // watcher stays off, since its builds would replace them.
  const build = spawn(
    "pnpm",
    ["exec", "react-router", "build", "--sourcemapClient", "--sourcemapServer"],
    { cwd: appDirectory, stdio: "inherit" },
  );
  const code = await new Promise((resolve) => {
    build.once("exit", resolve);
  });
  if (code !== 0 || stopSignal) {
    process.exit(code ?? 0);
  }
}

let serving = Promise.resolve();
let servingQueued = false;

function serveLatestBuildWhenIdle() {
  // Builds that finish while a preview starts collapse into one more restart.
  if (servingQueued) {
    return;
  }
  servingQueued = true;
  serving = serving.then(async () => {
    servingQueued = false;
    if (stopSignal) {
      return;
    }
    try {
      await serveLatestBuild();
    } catch (error) {
      console.error(error);
      await shutDown(null, 1);
    }
  });
}

// Snapshots of runs that were killed outright.
await rm(snapshotsDirectory, { recursive: true, force: true });
proxies = await Promise.all([
  startProxy(publicHost, appPort, (preview) => preview.appPort),
  startProxy("127.0.0.1", inspectorPort, (preview) => preview.inspectorPort),
]);
watchFile(buildCompleteMarkerPath, { interval: 500 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs) {
    return;
  }
  // A starting build deletes the marker; the preview keeps serving until the build has finished.
  if (current.mtimeMs === 0) {
    console.log("\nBuilding Backoffice.\n");
    return;
  }
  console.log("\nBackoffice build finished, starting a preview of it.\n");
  serveLatestBuildWhenIdle();
});
serveLatestBuildWhenIdle();

// The wrapper rebuilds rather than `turbo watch` running the preview: Turbo restarts a task whose
// dependencies rebuilt, which would stop the preview serving until its replacement is up.
if (!enableSourceMaps) {
  buildWatcher = spawn(
    "pnpm",
    [
      "exec",
      "turbo",
      "watch",
      "build",
      // Watch mode only reads the cache unless told otherwise, so every bench rebuilt the packages.
      "--experimental-write-cache",
      "--filter=@fragno-apps/backoffice-rr",
      "--output-logs=errors-only",
    ],
    { cwd: path.resolve(appDirectory, "../.."), stdio: ["ignore", "inherit", "inherit"] },
  );
  buildWatcher.once("exit", (code) => {
    if (!stopSignal) {
      console.error("\nThe Backoffice build watcher exited.");
      void shutDown(null, code ?? 1);
    }
  });
}
