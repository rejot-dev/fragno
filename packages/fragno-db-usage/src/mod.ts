import { createFragnoDatabaseLibrary, fragnoDatabaseLibrary } from "@fragno-dev/fragno-db-library";
import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { KyselyPGlite } from "kysely-pglite";
import { Kysely } from "kysely";
import { rmSync } from "node:fs";

const pgFolder = "./fragno-db-usage.pglite";

if (process.argv.includes("--clean")) {
  rmSync(pgFolder, { recursive: true, force: true });
}

const inMemory = !process.argv.includes("--file");

const { dialect } = await KyselyPGlite.create(inMemory ? undefined : pgFolder);
const kysely = new Kysely({
  dialect,
});

const adapter = new KyselyAdapter({
  db: kysely,
  provider: "postgresql",
});

if (import.meta.main && process.argv.includes("--migrate")) {
  const didMigrate = await fragnoDatabaseLibrary.runMigrations(adapter);
  if (didMigrate) {
    console.log("Migrations applied.");
  } else {
    console.log("No migrations needed.");
  }
}

export const client = await fragnoDatabaseLibrary.createClient(adapter);

export const libraryClient = createFragnoDatabaseLibrary(client);

const post = await libraryClient.createPost({
  title: "Hello, world!",
  content: "This is a test post",
});

console.log(post);
