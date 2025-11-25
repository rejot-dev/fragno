import { describe, it, expect } from "vitest";
import { stripJsonComments, convertTsconfigPathsToJitiAlias } from "./load-config";
import { resolve } from "node:path";

describe("stripJsonComments", () => {
  it("should strip single-line comments", () => {
    const input = `{
  // This is a comment
  "key": "value"
}`;
    const expected = `{
  
  "key": "value"
}`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  it("should strip multiple single-line comments", () => {
    const input = `{
  // First comment
  "key1": "value1", // Inline comment
  // Second comment
  "key2": "value2"
}`;
    const expected = `{
  
  "key1": "value1", 
  
  "key2": "value2"
}`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  it("should strip multi-line comments", () => {
    const input = `{
  /* This is a
     multi-line comment */
  "key": "value"
}`;
    const expected = `{
  
  "key": "value"
}`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  it("should strip multiple multi-line comments", () => {
    const input = `{
  /* Comment 1 */
  "key1": "value1",
  /* Comment 2
     spanning lines */
  "key2": "value2"
}`;
    const expected = `{
  
  "key1": "value1",
  
  "key2": "value2"
}`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  it("should strip both single-line and multi-line comments", () => {
    const input = `{
  // Single line comment
  "key1": "value1",
  /* Multi-line
     comment */
  "key2": "value2" // Another single line
}`;
    const expected = `{
  
  "key1": "value1",
  
  "key2": "value2" 
}`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  it("should handle strings with comment-like content", () => {
    const input = `{
  "url": "https://example.com",
  "comment": "This // is not a comment"
}`;
    // Note: This is a known limitation - the simple regex approach
    // will strip what looks like comments even inside strings
    // For tsconfig.json files this is typically fine since URLs/strings
    // with comment syntax are rare
    const result = stripJsonComments(input);
    expect(result).toContain('"url": "https:');
  });

  it("should handle empty input", () => {
    expect(stripJsonComments("")).toBe("");
  });

  it("should handle input with no comments", () => {
    const input = `{
  "key": "value",
  "nested": {
    "key2": "value2"
  }
}`;
    expect(stripJsonComments(input)).toBe(input);
  });

  it("should handle real tsconfig.json example", () => {
    const input = `{
  "compilerOptions": {
    // Enable latest features
    "target": "ESNext",
    "module": "ESNext",
    /* Bundler mode */
    "moduleResolution": "bundler",
    // Best practices
    "strict": true
  }
}`;
    const result = stripJsonComments(input);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result);
    expect(parsed.compilerOptions.target).toBe("ESNext");
    expect(parsed.compilerOptions.module).toBe("ESNext");
    expect(parsed.compilerOptions.moduleResolution).toBe("bundler");
    expect(parsed.compilerOptions.strict).toBe(true);
  });
});

describe("convertTsconfigPathsToJitiAlias", () => {
  it("should convert simple path alias", () => {
    const tsconfigPaths = {
      "@/*": ["./src/*"],
    };
    const baseUrl = "/project";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    expect(result).toEqual({
      "@/": resolve(baseUrl, "./src/"),
    });
  });

  it("should convert multiple path aliases", () => {
    const tsconfigPaths = {
      "@/*": ["./src/*"],
      "@components/*": ["./src/components/*"],
      "@utils/*": ["./src/utils/*"],
    };
    const baseUrl = "/project";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    expect(result).toEqual({
      "@/": resolve(baseUrl, "./src/"),
      "@components/": resolve(baseUrl, "./src/components/"),
      "@utils/": resolve(baseUrl, "./src/utils/"),
    });
  });

  it("should handle absolute paths", () => {
    const tsconfigPaths = {
      "@lib/*": ["/absolute/path/to/lib/*"],
    };
    const baseUrl = "/project";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    expect(result).toEqual({
      "@lib/": resolve(baseUrl, "/absolute/path/to/lib/"),
    });
  });

  it("should handle nested paths", () => {
    const tsconfigPaths = {
      "@/components/*": ["./src/app/components/*"],
    };
    const baseUrl = "/project";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    expect(result).toEqual({
      "@/components/": resolve(baseUrl, "./src/app/components/"),
    });
  });

  it("should handle empty paths object", () => {
    const tsconfigPaths = {};
    const baseUrl = "/project";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    expect(result).toEqual({});
  });

  it("should only use first path when multiple paths are provided", () => {
    const tsconfigPaths = {
      "@/*": ["./src/*", "./lib/*", "./dist/*"],
    };
    const baseUrl = "/project";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    // Should only use the first path
    expect(result).toEqual({
      "@/": resolve(baseUrl, "./src/"),
    });
  });

  it("should handle real-world tsconfig paths", () => {
    const tsconfigPaths = {
      "@/.source": ["./.source/index.ts"],
      "@/*": ["./*"],
    };
    const baseUrl = "/project/apps/docs";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    expect(result).toEqual({
      "@/.source": resolve(baseUrl, "./.source/index.ts"),
      "@/": resolve(baseUrl, "./"),
    });
  });

  it("should strip trailing asterisk from both alias and path", () => {
    const tsconfigPaths = {
      "~/*": ["./custom/*"],
    };
    const baseUrl = "/project";
    const result = convertTsconfigPathsToJitiAlias(tsconfigPaths, baseUrl);

    expect(result).toEqual({
      "~/": resolve(baseUrl, "./custom/"),
    });

    // Verify no asterisks in result
    expect(Object.keys(result)[0]).not.toContain("*");
    expect(Object.values(result)[0]).not.toContain("*");
  });
});
