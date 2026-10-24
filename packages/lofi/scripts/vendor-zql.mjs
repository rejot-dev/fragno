// Copies the ZQL query builder, IVM operators, and zqlite's TableSource from a checkout of
// rocicorp/mono into src/zql/vendor, keeping mono's package layout so relative imports resolve
// unchanged. zqlite's native SQLite bindings are replaced by Fragno modules (see REPLACEMENTS).
//
// Usage: node scripts/vendor-zql.mjs <path-to-mono-checkout>

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRIES = [
  "zql/src/builder/builder.ts",
  "zql/src/ivm/array-view.ts",
  "zql/src/ivm/memory-storage.ts",
  "zql/src/query/create-builder.ts",
  "zql/src/query/query-internals.ts",
  "zql/src/query/query-impl.ts",
  "zqlite/src/table-source.ts",
  "zero-types/src/schema.ts",
  "zero-protocol/src/ast.ts",
];

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zqlRoot = join(packageRoot, "src/zql");
const vendorRoot = join(zqlRoot, "vendor");

// Vendored modules that are swapped for Fragno modules, by their path in mono's packages.
const REPLACEMENTS = new Map([
  ["zqlite/src/db.ts", join(zqlRoot, "zqlite-database.ts")],
  ["zqlite/src/index-usage.ts", join(zqlRoot, "zqlite-shims.ts")],
  ["@rocicorp/zero-sqlite3", join(zqlRoot, "zqlite-shims.ts")],
]);

// Edits to vendored files, each anchored on text that must occur exactly once upstream.
const PATCHES = [
  {
    // Browser workers have no `process`.
    file: "shared/src/config.ts",
    find: "export const isProd = process.env.NODE_ENV === 'production';",
    replace:
      "export const isProd = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env?.NODE_ENV === 'production';",
  },
  {
    // Lets the replica rewind a source to the rows it held before a batch that SQLite already
    // applied, so the batch's changes can be pushed one at a time; see src/zql/engine.ts.
    file: "zqlite/src/table-source.ts",
    find: "  #getStatementsFor(db: Database) {",
    replace: `  /**
   * Fragno patch: makes reads show \`row\` in place of the backing table's row with the primary key
   * of \`key\`, or no row when \`row\` is undefined, until {@link setDB}. Requires \`deferWrites\`.
   */
  restoreRowsBeforeBatch(rows: Iterable<readonly [key: Row, row: Row | undefined]>): void {
    const delta = must(this.#delta, 'restoreRowsBeforeBatch requires deferWrites');
    for (const [key, row] of rows) {
      if (row === undefined) {
        delta.delete(key);
      } else {
        delta.set(row);
      }
    }
  }

  #getStatementsFor(db: Database) {`,
  },
];

const IMPORT_PATTERN = /^((?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?)(['"])([^'"]+)\2/gm;

const monoRoot = process.argv[2];
if (!monoRoot) {
  console.error("Usage: node scripts/vendor-zql.mjs <path-to-mono-checkout>");
  process.exit(1);
}
const monoPackages = join(resolve(monoRoot), "packages");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: monoRoot,
  encoding: "utf8",
}).trim();

const files = collectFiles();
rmSync(vendorRoot, { recursive: true, force: true });
for (const file of files) {
  const source = readFileSync(join(monoPackages, file), "utf8");
  const target = join(vendorRoot, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `// Vendored from rocicorp/mono@${commit} packages/${file}. Do not edit; run scripts/vendor-zql.mjs.\n` +
      // mono compiles with different strictness flags and TypeScript version than Lofi.
      `// @ts-nocheck\n` +
      applyPatches(file, rewriteImports(file, source)),
  );
}
for (const patch of PATCHES) {
  if (!files.includes(patch.file)) {
    throw new Error(`Patched file is no longer vendored: ${patch.file}`);
  }
}
cpSync(join(resolve(monoRoot), "LICENSE"), join(vendorRoot, "LICENSE"));
writeFileSync(join(vendorRoot, "UPSTREAM"), `rocicorp/mono@${commit}\n`);
console.log(`Vendored ${files.length} files from rocicorp/mono@${commit}.`);

function collectFiles() {
  const seen = new Set();
  const pending = [...ENTRIES];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file) || REPLACEMENTS.has(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(join(monoPackages, file), "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[3];
      if (specifier.startsWith(".")) {
        pending.push(relative(monoPackages, resolve(dirname(join(monoPackages, file)), specifier)));
      }
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

function applyPatches(file, source) {
  let patched = source;
  for (const patch of PATCHES.filter((candidate) => candidate.file === file)) {
    const occurrences = patched.split(patch.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Patch anchor occurs ${occurrences} times in ${file}: ${patch.find}`);
    }
    patched = patched.replace(patch.find, () => patch.replace);
  }
  return patched;
}

function rewriteImports(file, source) {
  return source.replaceAll(IMPORT_PATTERN, (statement, head, quote, specifier) => {
    const imported = specifier.startsWith(".")
      ? relative(monoPackages, resolve(dirname(join(monoPackages, file)), specifier))
      : specifier;
    const replacement = REPLACEMENTS.get(imported);
    if (replacement === undefined) {
      return statement;
    }
    let path = relative(dirname(join(vendorRoot, file)), replacement);
    if (!path.startsWith(".")) {
      path = `./${path}`;
    }
    return `${head}${quote}${path}${quote}`;
  });
}
