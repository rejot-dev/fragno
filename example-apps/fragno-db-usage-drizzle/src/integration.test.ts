import { describe, expect, it, beforeEach, afterEach, assert } from "vitest";

import { cli } from "gunshi";

describe("Fragno Database Drizzle", () => {
  // Store original console.log
  const originalConsoleLog = console.log;
  let logs: string[] = [];

  beforeEach(() => {
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  describe("User Commands", async () => {
    const { userCommand, userSubCommands } = await import("./commands/user");

    it("should create a user", async () => {
      await cli(["create", "--email", "test@test.com", "--name", "Test User"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs).toContain("Created user:");
      assert(logs.some((log) => log.includes("test@test.com")));
    });

    it("should list users", async () => {
      const { userCommand, userSubCommands } = await import("./commands/user");
      await cli(["list"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs).toContain("Users:");
      assert(logs.some((log) => log.includes("test@test.com")));
    });

    it("should get user by email", async () => {
      const { userCommand, userSubCommands } = await import("./commands/user");
      await cli(["get-by-email", "--email", "test@test.com"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs).toContain("User:");
      assert(logs.some((log) => log.includes("test@test.com")));
    });

    it("should get user by ID", async () => {
      const { userCommand, userSubCommands } = await import("./commands/user");
      await cli(["get", "--id", "1"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs).toContain("User:");
      assert(logs.some((log) => log.includes("test@test.com")));
    });

    it("should update a user", async () => {
      const { userCommand, userSubCommands } = await import("./commands/user");
      await cli(["update", "--id", "1", "--name", "Updated User"], userCommand, {
        subCommands: userSubCommands,
      });

      assert(logs.some((log) => log.includes("User 1 updated successfully")));
      assert(logs.some((log) => log.includes("Updated User")));
    });
  });

  describe("Post Commands", () => {
    it("should create a post", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(
        ["create", "--title", "Test Post", "--content", "This is a test post", "--authorId", "1"],
        postCommand,
        {
          subCommands: postSubCommands,
        },
      );

      expect(logs).toContain("Created blog post:");
      assert(logs.some((log) => log.includes("Test Post")));
    });

    it("should list posts", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["list"], postCommand, {
        subCommands: postSubCommands,
      });

      expect(logs).toContain("Blog posts:");
      assert(logs.some((log) => log.includes("Test Post")));
    });

    it("should get post by ID", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["get", "--id", "1"], postCommand, {
        subCommands: postSubCommands,
      });

      expect(logs).toContain("Blog post:");
      assert(logs.some((log) => log.includes("Test Post")));
    });

    it("should update a post", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["update", "--id", "1", "--title", "Updated Post"], postCommand, {
        subCommands: postSubCommands,
      });

      assert(logs.some((log) => log.includes("Blog post 1 updated successfully")));
      assert(logs.some((log) => log.includes("Updated Post")));
    });
  });

  describe("Rating Commands", () => {
    it("should add an upvote to a post", async () => {
      const { ratingCommand, ratingSubCommands } = await import("./commands/rating");
      await cli(["upvote", "--reference", "1"], ratingCommand, {
        subCommands: ratingSubCommands,
      });

      assert(logs.some((log) => log.includes("Upvoted reference: 1")));
      assert(logs.some((log) => log.includes("Current rating: 1")));
    });
  });

  describe("Comment Commands", () => {
    it("should create multiple comments", async () => {
      const { commentCommand, commentSubCommands } = await import("./commands/comment");

      // Create first comment
      await cli(
        [
          "create",
          "--title",
          "First Comment",
          "--content",
          "This is the first comment",
          "--postReference",
          "1",
          "--userReference",
          "1",
        ],
        commentCommand,
        {
          subCommands: commentSubCommands,
        },
      );

      assert(logs.some((log) => log.includes("First Comment")));

      // Clear logs for next comment
      logs = [];

      // Create second comment
      await cli(
        [
          "create",
          "--title",
          "Second Comment",
          "--content",
          "This is the second comment",
          "--postReference",
          "1",
          "--userReference",
          "1",
        ],
        commentCommand,
        {
          subCommands: commentSubCommands,
        },
      );

      assert(logs.some((log) => log.includes("Second Comment")));

      // Clear logs for third comment
      logs = [];

      // Create third comment
      await cli(
        [
          "create",
          "--title",
          "Third Comment",
          "--content",
          "This is the third comment",
          "--postReference",
          "1",
          "--userReference",
          "1",
        ],
        commentCommand,
        {
          subCommands: commentSubCommands,
        },
      );

      assert(logs.some((log) => log.includes("Third Comment")));
    });

    it("should list posts with author and include comments", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["list-with-author"], postCommand, {
        subCommands: postSubCommands,
      });

      expect(logs).toContain("Blog posts with authors:");

      // Check that the post is included
      assert(logs.some((log) => log.includes("Updated Post")));

      // Check that the author is included
      assert(logs.some((log) => log.includes("Updated User")));

      // Check that comments are included
      assert(logs.some((log) => log.includes("First Comment")));
      assert(logs.some((log) => log.includes("Second Comment")));
      assert(logs.some((log) => log.includes("Third Comment")));

      // Verify comments array exists in the output
      assert(logs.some((log) => log.includes("comments")));

      assert(logs.some((log) => log.includes("rating")));
    });
  });

  describe("Relations Commands", () => {
    it("should test auth joins with explicit queries", async () => {
      const { relationsCommand, relationsSubCommands } = await import("./commands/relations");
      await cli(["test-auth-relations"], relationsCommand, {
        subCommands: relationsSubCommands,
      });

      expect(logs).toContain("Testing auth joins with explicit queries...");
      assert(logs.some((log) => log.includes("=== Auth Sessions with Owners (explicit join) ===")));
      assert(logs.some((log) => log.includes("=== Auth Users with Sessions ===")));
      assert(
        logs.some((log) => log.includes("✓ Auth joins working correctly with explicit queries!")),
      );
    });

    it("should test comment relations", async () => {
      const { relationsCommand, relationsSubCommands } = await import("./commands/relations");
      await cli(["test-comment-relations", "--postReference", "1"], relationsCommand, {
        subCommands: relationsSubCommands,
      });

      assert(logs.some((log) => log.includes("Testing comment relations for post 1...")));
      assert(logs.some((log) => log.includes("=== Comments with Nested Replies ===")));
      assert(
        logs.some((log) => log.includes("✓ Comment self-referential relations working correctly!")),
      );
    });

    it("should test all Fragno relations", async () => {
      const { relationsCommand, relationsSubCommands } = await import("./commands/relations");
      await cli(["test-all"], relationsCommand, {
        subCommands: relationsSubCommands,
      });

      assert(logs.some((log) => log.includes("=== Testing All Fragno Relation-Style Queries ===")));
      assert(logs.some((log) => log.includes("✓ Auth sessions with owners (explicit join):")));
      assert(logs.some((log) => log.includes("✓ Auth users with sessions:")));
      assert(logs.some((log) => log.includes("✓ Comments with replies:")));
      assert(logs.some((log) => log.includes("=== All Fragno Relation-Style Queries Passed! ===")));

      // Verify the key messages about what was tested
      assert(logs.some((log) => log.includes("Explicit joins still work for auth data")));
      assert(
        logs.some((log) => log.includes("Self-referential comment trees still work correctly")),
      );
    });
  });
});
