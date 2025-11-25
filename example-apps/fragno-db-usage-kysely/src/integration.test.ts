import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { cli } from "gunshi";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

describe("Fragno Database Kysely", () => {
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
      expect(logs.some((log) => log.includes("test@test.com"))).toBe(true);
    });

    it("should list users", async () => {
      await cli(["list"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs).toContain("Users:");
      expect(logs.some((log) => log.includes("test@test.com"))).toBe(true);
    });

    it("should get user by email", async () => {
      await cli(["get-by-email", "--email", "test@test.com"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs).toContain("User:");
      expect(logs.some((log) => log.includes("test@test.com"))).toBe(true);
    });

    it("should get user by ID", async () => {
      await cli(["get", "--id", "1"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs).toContain("User:");
      expect(logs.some((log) => log.includes("test@test.com"))).toBe(true);
    });

    it("should update a user", async () => {
      await cli(["update", "--id", "1", "--name", "Updated User"], userCommand, {
        subCommands: userSubCommands,
      });

      expect(logs.some((log) => log.includes("User 1 updated successfully"))).toBe(true);
      expect(logs.some((log) => log.includes("Updated User"))).toBe(true);
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
      expect(logs.some((log) => log.includes("Test Post"))).toBe(true);
    });

    it("should list posts", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["list"], postCommand, {
        subCommands: postSubCommands,
      });

      expect(logs).toContain("Blog posts:");
      expect(logs.some((log) => log.includes("Test Post"))).toBe(true);
    });

    it("should get post by ID", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["get", "--id", "1"], postCommand, {
        subCommands: postSubCommands,
      });

      expect(logs).toContain("Blog post:");
      expect(logs.some((log) => log.includes("Test Post"))).toBe(true);
    });

    it("should update a post", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["update", "--id", "1", "--title", "Updated Post"], postCommand, {
        subCommands: postSubCommands,
      });

      expect(logs.some((log) => log.includes("Blog post 1 updated successfully"))).toBe(true);
      expect(logs.some((log) => log.includes("Updated Post"))).toBe(true);
    });
  });

  describe("Rating Commands", () => {
    it("should add an upvote to a post", async () => {
      const { ratingCommand, ratingSubCommands } = await import("./commands/rating");
      await cli(["upvote", "--reference", "1"], ratingCommand, {
        subCommands: ratingSubCommands,
      });

      expect(logs.some((log) => log.includes("Upvoted reference: 1"))).toBe(true);
      expect(logs.some((log) => log.includes("Current rating: 1"))).toBe(true);
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

      expect(logs.some((log) => log.includes("First Comment"))).toBe(true);

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

      expect(logs.some((log) => log.includes("Second Comment"))).toBe(true);

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

      expect(logs.some((log) => log.includes("Third Comment"))).toBe(true);
    });

    it("should list comments for a post", async () => {
      const { commentCommand, commentSubCommands } = await import("./commands/comment");
      await cli(["list", "--postReference", "1"], commentCommand, {
        subCommands: commentSubCommands,
      });

      expect(logs).toContain("Comments for post 1:");

      // Check that all three comments are listed
      expect(logs.some((log) => log.includes("First Comment"))).toBe(true);
      expect(logs.some((log) => log.includes("Second Comment"))).toBe(true);
      expect(logs.some((log) => log.includes("Third Comment"))).toBe(true);
    });

    it("should list posts with author and include comments", async () => {
      const { postCommand, postSubCommands } = await import("./commands/post");
      await cli(["list-with-author"], postCommand, {
        subCommands: postSubCommands,
      });

      expect(logs).toContain("Blog posts with authors:");

      // Check that the post is included
      expect(logs.some((log) => log.includes("Updated Post"))).toBe(true);

      // Check that the author is included
      expect(logs.some((log) => log.includes("Updated User"))).toBe(true);

      // Check that comments are included
      expect(logs.some((log) => log.includes("First Comment"))).toBe(true);
      expect(logs.some((log) => log.includes("Second Comment"))).toBe(true);
      expect(logs.some((log) => log.includes("Third Comment"))).toBe(true);

      // Verify comments array exists in the output
      expect(logs.some((log) => log.includes("comments"))).toBe(true);

      expect(logs.some((log) => log.includes("rating"))).toBe(true);
    });
  });

  describe("DB Generate Command", () => {
    const outputDir = resolve(process.cwd(), "_generated");

    afterEach(async () => {
      // Clean up generated directory
      if (existsSync(outputDir)) {
        await rm(outputDir, { recursive: true, force: true });
      }
    });

    it("should generate schema files to output directory", async () => {
      const { generateCommand } = await import("@fragno-dev/cli");

      await cli(
        ["./src/fragno/comment-fragment.ts", "./src/fragno/rating-fragment.ts", "-o", "_generated"],
        generateCommand,
        {
          name: "fragno-cli db generate",
          version: "test",
        },
      );

      // Verify output directory was created
      expect(existsSync(outputDir)).toBe(true);

      // Verify files were generated
      expect(logs.some((log) => log.includes("✓ Generated:"))).toBe(true);
      expect(logs.some((log) => log.includes("Schema generated successfully"))).toBe(true);
      expect(logs.some((log) => log.includes("fragno-db-comment"))).toBe(true);
      expect(logs.some((log) => log.includes("fragno-db-rating"))).toBe(true);
      expect(logs.some((log) => log.includes("Files generated: 3"))).toBe(true);
    });
  });
});
