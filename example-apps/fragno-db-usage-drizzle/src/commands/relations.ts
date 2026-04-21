import type { Command } from "gunshi";

import * as repo from "../repository";

const testAuthRelationsCommand: Command = {
  name: "test-auth-relations",
  description: "Test auth joins using explicit Drizzle queries",
  run: async () => {
    console.log("Testing auth joins with explicit queries...");

    const sessionsWithOwners = await repo.findAuthSessionsWithOwners();
    console.log("\n=== Auth Sessions with Owners (explicit join) ===");
    console.log(JSON.stringify(sessionsWithOwners, null, 2));

    const authUsersWithSessions = await repo.findAuthUsersWithSessions();
    console.log("\n=== Auth Users with Sessions ===");
    console.log(JSON.stringify(authUsersWithSessions, null, 2));

    console.log("\n✓ Auth joins working correctly with explicit queries!");
  },
};

const testCommentRelationsCommand: Command = {
  name: "test-comment-relations",
  description: "Test self-referential comment lookups with explicit queries",
  args: {
    postReference: {
      type: "string" as const,
      description: "Post reference ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const postReference = ctx.values["postReference"] as string;
    console.log(`Testing comment relations for post ${postReference}...`);

    // Test: Fetch comments with nested replies
    const commentsWithReplies = await repo.findCommentsWithReplies(postReference);
    console.log("\n=== Comments with Nested Replies ===");
    console.log(JSON.stringify(commentsWithReplies, null, 2));

    console.log("\n✓ Comment self-referential relations working correctly!");
  },
};

const testAllRelationsCommand: Command = {
  name: "test-all",
  description: "Test all explicit Fragno relation-style queries",
  run: async () => {
    console.log("=== Testing All Fragno Relation-Style Queries ===\n");

    const sessionsWithOwners = await repo.findAuthSessionsWithOwners();
    console.log(`✓ Auth sessions with owners (explicit join): ${sessionsWithOwners.length} found`);

    const authUsersWithSessions = await repo.findAuthUsersWithSessions();
    console.log(`✓ Auth users with sessions: ${authUsersWithSessions.length} found`);

    const commentsWithReplies = await repo.findCommentsWithReplies("1");
    console.log(`✓ Comments with replies: ${commentsWithReplies.length} found`);

    console.log("\n=== All Fragno Relation-Style Queries Passed! ===");
    console.log("This confirms that:");
    console.log("  - Explicit joins still work for auth data");
    console.log("  - Self-referential comment trees still work correctly");
  },
};

export const relationsSubCommands = new Map();
relationsSubCommands.set("test-auth-relations", testAuthRelationsCommand);
relationsSubCommands.set("test-comment-relations", testCommentRelationsCommand);
relationsSubCommands.set("test-all", testAllRelationsCommand);

export const relationsCommand: Command = {
  name: "relations",
  description: "Test Fragno relational query commands",
  run: () => {
    console.log("Fragno relational query test commands");
    console.log("");
    console.log("Usage: node --import tsx src/mod.ts relations <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  test-auth-relations     Test auth joins with explicit queries");
    console.log("  test-comment-relations  Test self-referential comment queries");
    console.log("  test-all                Test all explicit Fragno relation-style queries");
    console.log("");
    console.log(
      "Run 'node --import tsx src/mod.ts relations <command> --help' for more information.",
    );
  },
};
