import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, type FormatOptions } from "oxfmt";
import { createServer } from "vite";

type GeneratedBackofficeRuntimeToolStaticFile = {
  path: string;
  content: string;
};

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BACKOFFICE_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const REPOSITORY_DIRECTORY = resolve(BACKOFFICE_DIRECTORY, "../..");
const OXFMT_CONFIG_PATH = resolve(REPOSITORY_DIRECTORY, ".oxfmtrc.json");
const STATIC_CONTENT_DIRECTORY = resolve(BACKOFFICE_DIRECTORY, "content/static");
const CODEMODE_STATIC_DIRECTORY = resolve(STATIC_CONTENT_DIRECTORY, "codemode");
const TERMINAL_COMMAND_SPECS_PATH = resolve(
  STATIC_CONTENT_DIRECTORY,
  "terminal/terminal-spec.json",
);

function backofficeRuntimeToolStaticOutputPath(path: string) {
  const staticPrefix = "/static/";
  if (!path.startsWith(staticPrefix)) {
    throw new Error(`Backoffice runtime tool static generation received an invalid path: ${path}`);
  }
  return resolve(STATIC_CONTENT_DIRECTORY, path.slice(staticPrefix.length));
}

async function createExpectedBackofficeRuntimeToolStaticFiles() {
  const vite = await createServer({
    root: BACKOFFICE_DIRECTORY,
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    resolve: {
      alias: {
        "@": resolve(BACKOFFICE_DIRECTORY, "app"),
      },
    },
  });

  try {
    const generationModule = (await vite.ssrLoadModule(
      "/app/fragno/codemode/codemode-static-type-generation.ts",
    )) as {
      generateBackofficeRuntimeToolStaticFiles(): GeneratedBackofficeRuntimeToolStaticFile[];
    };
    const formatOptions = JSON.parse(await readFile(OXFMT_CONFIG_PATH, "utf8")) as FormatOptions;
    const expectedFiles = await Promise.all(
      generationModule.generateBackofficeRuntimeToolStaticFiles().map(async (file) => {
        const outputPath = backofficeRuntimeToolStaticOutputPath(file.path);
        const result = await format(outputPath, file.content, formatOptions);
        if (result.errors.length > 0) {
          throw new Error(
            `Unable to format generated Backoffice runtime tool static file '${file.path}': ${result.errors
              .map((error) => error.message)
              .join("; ")}`,
          );
        }
        return [outputPath, result.code] as const;
      }),
    );
    return new Map(expectedFiles);
  } finally {
    await vite.close();
  }
}

async function findManagedBackofficeRuntimeToolStaticFiles() {
  const managedFiles = new Set<string>([
    resolve(CODEMODE_STATIC_DIRECTORY, "system.d.ts"),
    resolve(CODEMODE_STATIC_DIRECTORY, "sources/mcp.d.ts"),
    TERMINAL_COMMAND_SPECS_PATH,
  ]);
  const providerDirectory = resolve(CODEMODE_STATIC_DIRECTORY, "providers");

  try {
    for (const entry of await readdir(providerDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        managedFiles.add(resolve(providerDirectory, entry.name));
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return managedFiles;
}

async function findStaleBackofficeRuntimeToolStaticPaths(
  expectedFiles: ReadonlyMap<string, string>,
): Promise<string[]> {
  const actualFiles = await findManagedBackofficeRuntimeToolStaticFiles();
  const stalePaths: string[] = [];

  for (const [path, expectedContent] of expectedFiles) {
    try {
      if ((await readFile(path, "utf8")) !== expectedContent) {
        stalePaths.push(path);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        stalePaths.push(path);
        continue;
      }
      throw error;
    }
    actualFiles.delete(path);
  }

  return [...stalePaths, ...actualFiles].sort();
}

function formatBackofficeRuntimeToolStaticPaths(paths: readonly string[]) {
  return paths.map((path) => `  - ${relative(BACKOFFICE_DIRECTORY, path)}`).join("\n");
}

async function checkBackofficeRuntimeToolStaticFiles(expectedFiles: ReadonlyMap<string, string>) {
  const stalePaths = await findStaleBackofficeRuntimeToolStaticPaths(expectedFiles);
  if (stalePaths.length === 0) {
    return;
  }

  throw new Error(
    `Backoffice runtime tool static file check failed. Run 'pnpm codemode:generate' in apps/backoffice.\n${formatBackofficeRuntimeToolStaticPaths(stalePaths)}`,
  );
}

async function writeBackofficeRuntimeToolStaticFiles(expectedFiles: ReadonlyMap<string, string>) {
  await rm(resolve(CODEMODE_STATIC_DIRECTORY, "providers"), { recursive: true, force: true });

  for (const [path, content] of expectedFiles) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

async function main() {
  const check = process.argv.includes("--check");
  const fix = process.argv.includes("--fix");
  if (check && fix) {
    throw new Error("Codemode static type generation accepts either --check or --fix, not both.");
  }

  const expectedFiles = await createExpectedBackofficeRuntimeToolStaticFiles();
  if (check) {
    await checkBackofficeRuntimeToolStaticFiles(expectedFiles);
    return;
  }
  if (fix) {
    const stalePaths = await findStaleBackofficeRuntimeToolStaticPaths(expectedFiles);
    if (stalePaths.length === 0) {
      return;
    }

    await writeBackofficeRuntimeToolStaticFiles(expectedFiles);
    console.error(
      `Updated stale Backoffice runtime tool static files. Review and stage these changes:\n${formatBackofficeRuntimeToolStaticPaths(stalePaths)}`,
    );
    process.exitCode = 1;
    return;
  }
  await writeBackofficeRuntimeToolStaticFiles(expectedFiles);
}

await main();
