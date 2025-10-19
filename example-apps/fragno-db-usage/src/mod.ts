import { createFragnoDatabaseLibrary } from "@fragno-dev/fragno-db-library";
import { rmSync } from "node:fs";
import { pgFolder } from "./kysely/dialect";

// Re-export boundCommentLib so this file can be targeted by CLI
export { boundCommentLib } from "./databases";

import { boundCommentLib } from "./databases";

if (process.argv.includes("--clean")) {
  rmSync(pgFolder, { recursive: true, force: true });
}

if (import.meta.main && process.argv.includes("--migrate")) {
  const didMigrate = await boundCommentLib.runMigrations();
  if (didMigrate) {
    console.log("Migrations applied.");
  } else {
    console.log("No migrations needed.");
  }
}

/**
 * Lazy client creation - only happens when called.
 * This prevents version check errors during CLI schema generation.
 */
export async function getClient() {
  const client = await boundCommentLib.createClient();
  return createFragnoDatabaseLibrary(client);
}

// For immediate usage in this script
if (import.meta.main) {
  const libraryClient = await getClient();
  console.log("Client created successfully!");

  // Example usage
  const comment = await libraryClient.createComment({
    title: "Test Comment",
    content: "This is a test comment",
    postReference: "post-123",
    userReference: "user-456",
  });
  console.log("Created comment:", comment);

  const comments = await libraryClient.getComments("post-123");
  console.log("Comments for post-123:", comments);
}
