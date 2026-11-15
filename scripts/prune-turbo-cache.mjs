import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// Turbo never evicts its local cache, and every worktree of a checkout shares the main worktree's,
// so it grows without bound. Removes the entries written more than `days` days ago. Read times would
// spare entries still in use, but backup and indexing scans read the whole cache.
const days = Number(process.argv[2] ?? 14);
if (!Number.isInteger(days) || days < 0) {
  throw new Error("Usage: pnpm cache:prune [days]");
}

const gitCommonDirectory = execFileSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { encoding: "utf8" },
).trim();
const cacheDirectory = path.join(path.dirname(gitCommonDirectory), ".turbo/cache");
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

// An entry is its archive plus metadata files that share its hash.
const entries = new Map();
for (const name of readdirSync(cacheDirectory)) {
  const hash = /^[0-9a-f]+/.exec(name)?.[0];
  if (!hash) {
    continue;
  }
  const filePath = path.join(cacheDirectory, name);
  const stats = statSync(filePath);
  const entry = entries.get(hash) ?? { files: [], writtenMs: 0, bytes: 0 };
  entry.files.push(filePath);
  entry.writtenMs = Math.max(entry.writtenMs, stats.mtimeMs);
  entry.bytes += stats.size;
  entries.set(hash, entry);
}

let removedEntries = 0;
let removedBytes = 0;
for (const entry of entries.values()) {
  if (entry.writtenMs >= cutoffMs) {
    continue;
  }
  for (const filePath of entry.files) {
    rmSync(filePath, { force: true });
  }
  removedEntries += 1;
  removedBytes += entry.bytes;
}

console.log(
  `Removed ${removedEntries} of ${entries.size} Turbo cache entries older than ${days} days ` +
    `(${(removedBytes / 1024 ** 3).toFixed(1)} GB) from ${cacheDirectory}.`,
);
