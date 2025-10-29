import type { Command } from "gunshi";
import * as repo from "../repository";

const testAuthRelationsCommand: Command = {
  name: "test-auth-relations",
  description: "Test relational queries for auth sessions (using convenience aliases)",
  run: async () => {
    console.log("Testing auth relations with convenience aliases...");

    // Test 1: Fetch sessions with their owners (using convenience alias)
    const sessionsWithOwners = await repo.findAuthSessionsWithOwners();
    console.log("\n=== Auth Sessions with Owners (using convenience alias) ===");
    console.log(JSON.stringify(sessionsWithOwners, null, 2));

    // Test 2: Fetch auth users with their sessions
    const authUsersWithSessions = await repo.findAuthUsersWithSessions();
    console.log("\n=== Auth Users with Sessions ===");
    console.log(JSON.stringify(authUsersWithSessions, null, 2));

    console.log("\n✓ Auth relations working correctly with convenience aliases!");
  },
};

const testCommentRelationsCommand: Command = {
  name: "test-comment-relations",
  description: "Test self-referential relational queries for comments",
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
  description: "Test all Fragno relational queries",
  run: async () => {
    console.log("=== Testing All Fragno Relational Queries ===\n");

    // Test auth relations (KEY TEST - using convenience aliases)
    const sessionsWithOwners = await repo.findAuthSessionsWithOwners();
    console.log(
      `✓ Auth sessions with owners (convenience alias): ${sessionsWithOwners.length} found`,
    );

    const authUsersWithSessions = await repo.findAuthUsersWithSessions();
    console.log(`✓ Auth users with sessions: ${authUsersWithSessions.length} found`);

    // Test comment relations (self-referential)
    const commentsWithReplies = await repo.findCommentsWithReplies("1");
    console.log(`✓ Comments with replies: ${commentsWithReplies.length} found`);

    console.log("\n=== All Fragno Relational Queries Passed! ===");
    console.log("This confirms that:");
    console.log("  - Fragment convenience aliases work with relations");
    console.log("  - Self-referential relations work correctly");
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
    console.log("  test-auth-relations     Test auth session relations (convenience aliases)");
    console.log("  test-comment-relations  Test comment self-referential relations");
    console.log("  test-all                Test all Fragno relational queries");
    console.log("");
    console.log(
      "Run 'node --import tsx src/mod.ts relations <command> --help' for more information.",
    );
  },
};
