import { describe, it, expect } from "vitest";
import { parseMarkdownFile, markdownToSubject } from "./parser.js";

describe("parseMarkdownFile", () => {
  it("should extract title from markdown", () => {
    const content = `# Test Title

Description here`;

    const result = parseMarkdownFile(content);
    expect(result.title).toBe("Test Title");
  });

  it("should extract description", () => {
    const content = `# Test Title

This is a description.

\`\`\`typescript @fragno-imports
import { test } from "test";
\`\`\``;

    const result = parseMarkdownFile(content);
    expect(result.description).toBe("This is a description.");
  });

  it("should extract imports block", () => {
    const content = `# Test

\`\`\`typescript @fragno-imports
import { defineRoute } from "@fragno-dev/core";
import { z } from "zod";
\`\`\``;

    const result = parseMarkdownFile(content);
    expect(result.imports).toBe(`import { defineRoute } from "@fragno-dev/core";
import { z } from "zod";`);
  });

  it("should extract init block when present", () => {
    const content = `# Test

\`\`\`typescript @fragno-imports
import { x } from "y";
\`\`\`

\`\`\`typescript @fragno-init
const config = { key: "value" };
\`\`\``;

    const result = parseMarkdownFile(content);
    expect(result.init).toBe(`const config = { key: "value" };`);
  });

  it("should handle missing init block", () => {
    const content = `# Test

\`\`\`typescript @fragno-imports
import { x } from "y";
\`\`\``;

    const result = parseMarkdownFile(content);
    expect(result.init).toBe("");
  });

  it("should extract multiple test blocks", () => {
    const content = `# Test

\`\`\`typescript @fragno-imports
import { x } from "y";
\`\`\`

\`\`\`typescript @fragno-test
const test1 = "value1";
\`\`\`

This is explanation for test1.

\`\`\`typescript @fragno-test
const test2 = "value2";
\`\`\`

This is explanation for test2.`;

    const result = parseMarkdownFile(content);
    expect(result.testBlocks).toHaveLength(2);
    expect(result.testBlocks[0].code).toBe(`const test1 = "value1";`);
    expect(result.testBlocks[0].explanation).toContain("explanation for test1");
    expect(result.testBlocks[1].code).toBe(`const test2 = "value2";`);
    expect(result.testBlocks[1].explanation).toContain("explanation for test2");
  });
});

describe("markdownToSubject", () => {
  it("should convert parsed markdown to Subject", () => {
    const parsed = {
      title: "Test Subject",
      description: "Test description",
      imports: "import { x } from 'y';",
      init: "const config = {};",
      testBlocks: [{ code: "const test = 1;", explanation: "Test explanation" }],
      sections: [],
    };

    const result = markdownToSubject("test-id", parsed);

    expect(result.id).toBe("test-id");
    expect(result.title).toBe("Test Subject");
    expect(result.description).toBe("Test description");
    expect(result.imports).toBe("import { x } from 'y';");
    expect(result.init).toBe("const config = {};");
    expect(result.examples).toHaveLength(1);
    expect(result.examples[0].code).toBe("const test = 1;");
    expect(result.examples[0].explanation).toBe("Test explanation");
  });
});
