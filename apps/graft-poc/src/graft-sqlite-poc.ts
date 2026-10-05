import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { loadGraftExtension } from "./graft-extension";

const command = process.argv[2] ?? "seed";
if (command !== "seed" && command !== "clone") {
  throw new Error(`Unknown Graft POC command: ${command}`);
}
const remoteLogId = process.argv[3] ?? process.env["GRAFT_REMOTE_LOG_ID"] ?? "";
if (command === "clone" && !remoteLogId) {
  throw new Error("Graft clone requires a remote log ID: pnpm run clone REMOTE_LOG_ID");
}
const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const graftDirectory = resolve(appDirectory, ".graft");
const localDataDir = resolve(process.env["GRAFT_POC_DATA_DIR"] ?? `${graftDirectory}/${command}`);
const graftConfigPath = resolve(graftDirectory, `graft-${command}.toml`);

configureR2Environment();
writeGraftConfig();

// Graft reads its configuration when the native extension is loaded, so this
// import must remain after configureR2Environment and writeGraftConfig.
await loadGraftExtension();

const db = new DatabaseSync("file:backoffice?vfs=graft");
try {
  db.exec("PRAGMA journal_mode = MEMORY");

  if (command === "clone") {
    runGraftPragma(db, `PRAGMA graft_clone = ${quoteSqlString(remoteLogId)}`);
    runGraftPragma(db, "PRAGMA graft_pull");
    printRows(db);
  } else {
    seedLocalDatabase(db);
    // Verified locally with sqlite-graft@0.2.1, Node v26.10.0, and R2: clone the
    // same remote into two separate data directories, commit an insert in each,
    // then push A followed by B. A succeeds; B's prepare(...).all() synchronously
    // throws Error with code="ERR_SQLITE_ERROR", errcode=2 (SQLITE_INTERNAL),
    // errstr="unknown error", and a message starting with
    // "Graft error: Volume <id> has diverged from the remote" (plus Rust context).
    // B's local insert remains readable; a fresh remote clone contains only A's.
    // Retrying B's push throws again, and graft_status reports divergence with
    // one different commit on each side. This is not SQLITE_BUSY or a Promise
    // rejection. The generic code/errcode alone cannot identify divergence.
    // Deliberately let this fail: reset/replay or fork is an application decision,
    // and a successful local SQLite commit does not imply a successful push.
    runGraftPragma(db, "PRAGMA graft_push");
    printRows(db);
  }

  printGraftDiagnostics(db);
} finally {
  db.close();
}

function configureR2Environment() {
  const mappings = {
    R2_CELLD_BACKOFFICE_AWS_ACCESS_KEY_ID: "AWS_ACCESS_KEY_ID",
    R2_CELLD_BACKOFFICE_AWS_SECRET_ACCESS_KEY: "AWS_SECRET_ACCESS_KEY",
    R2_CELLD_BACKOFFICE_AWS_REGION: "AWS_REGION",
    R2_CELLD_BACKOFFICE_S3_ENDPOINT: "AWS_ENDPOINT",
  };

  for (const [sourceName, targetName] of Object.entries(mappings)) {
    const value = process.env[sourceName];
    if (!value) {
      throw new Error(`Graft R2 configuration is missing ${sourceName}`);
    }
    process.env[targetName] = value;
  }
}

function writeGraftConfig() {
  const configuredBucket = process.env["R2_CELLD_BACKOFFICE_CELLD_BUCKET"];
  if (!configuredBucket) {
    throw new Error("Graft R2 configuration is missing R2_CELLD_BACKOFFICE_CELLD_BUCKET");
  }

  // celld accepts an s3:// URI, while Graft expects only the bucket name.
  const bucket = configuredBucket.replace(/^s3:\/\//, "").replace(/\/$/, "");

  mkdirSync(graftDirectory, { recursive: true });
  mkdirSync(localDataDir, { recursive: true });
  writeFileSync(
    graftConfigPath,
    [
      `data_dir = ${quoteTomlString(localDataDir)}`,
      "",
      "[remote]",
      'type = "s3_compatible"',
      `bucket = ${quoteTomlString(bucket)}`,
      'prefix = "graft-sqlite-poc"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  process.env["GRAFT_CONFIG"] = graftConfigPath;
}

function seedLocalDatabase(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replication_events (
      id INTEGER PRIMARY KEY,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO replication_events (message, created_at) VALUES (?, ?)").run(
    "written locally, replicated through Graft",
    new Date().toISOString(),
  );
}

function printRows(db: DatabaseSync) {
  const rows = db
    .prepare("SELECT id, message, created_at FROM replication_events ORDER BY id DESC LIMIT 10")
    .all();
  console.log("SQLite rows:", rows);
}

function printGraftDiagnostics(db: DatabaseSync) {
  console.log("Graft version:", runGraftPragma(db, "PRAGMA graft_version"));
  console.log("Graft info:", runGraftPragma(db, "PRAGMA graft_info"));
  console.log("Graft status:", runGraftPragma(db, "PRAGMA graft_status"));
}

function runGraftPragma(db: DatabaseSync, sql: string) {
  return db.prepare(sql).all();
}

function quoteSqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteTomlString(value: string) {
  return JSON.stringify(value);
}
