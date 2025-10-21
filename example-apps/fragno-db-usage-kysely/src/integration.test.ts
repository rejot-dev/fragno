import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { cli } from "gunshi";

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
  });
});
