import { describe, it, expect } from "vitest";
import type { Subject } from "@fragno-dev/corpus";
import { getSubjects, getSubject } from "@fragno-dev/corpus";
import {
  addLineNumbers,
  filterByLineRange,
  buildSubjectsMarkdown,
  extractHeadingsAndBlocks,
} from "./corpus.js";

describe("corpus package integration", () => {
  it("should be able to find and load subjects directory from published package", () => {
    // This test verifies that the subjects directory is correctly included in the
    // published package and can be found when the code runs from dist/
    const subjects = getSubjects();

    // Should find at least one subject
    expect(subjects.length).toBeGreaterThan(0);

    // Each subject should have an id and title
    for (const subject of subjects) {
      expect(subject.id).toBeDefined();
      expect(subject.id.length).toBeGreaterThan(0);
      expect(subject.title).toBeDefined();
      expect(subject.title.length).toBeGreaterThan(0);
    }
  });

  it("should be able to load a specific subject file", () => {
    // Verify we can actually load a subject's content (not just list them)
    const subjects = getSubject("defining-routes");

    expect(subjects).toHaveLength(1);
    const subject = subjects[0];

    expect(subject.id).toBe("defining-routes");
    expect(subject.title).toBeDefined();
    expect(subject.title.length).toBeGreaterThan(0);

    // Subject should have sections (the actual markdown content)
    expect(subject.sections.length).toBeGreaterThan(0);
  });

  it("should handle loading multiple subjects at once", () => {
    const subjects = getSubject("defining-routes", "client-state-management");

    expect(subjects).toHaveLength(2);

    const ids = subjects.map((s) => s.id);
    expect(ids).toContain("defining-routes");
    expect(ids).toContain("client-state-management");
  });
});

describe("addLineNumbers", () => {
  it("should add line numbers with proper padding", () => {
    const content = "line 1\nline 2\nline 3";
    const result = addLineNumbers(content);

    expect(result).toBe("1│ line 1\n2│ line 2\n3│ line 3");
  });

  it("should pad line numbers correctly for multi-digit lines", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = addLineNumbers(content);

    const lines = result.split("\n");
    // First line should have padding
    expect(lines[0]).toBe("  1│ line 1");
    // Line 10 should have less padding
    expect(lines[9]).toBe(" 10│ line 10");
    // Line 100 should have no padding
    expect(lines[99]).toBe("100│ line 100");
  });

  it("should start from custom line number", () => {
    const content = "line 1\nline 2\nline 3";
    const result = addLineNumbers(content, 50);

    expect(result).toBe("50│ line 1\n51│ line 2\n52│ line 3");
  });

  it("should handle empty lines", () => {
    const content = "line 1\n\nline 3";
    const result = addLineNumbers(content);

    expect(result).toBe("1│ line 1\n2│ \n3│ line 3");
  });

  it("should handle single line", () => {
    const content = "single line";
    const result = addLineNumbers(content);

    expect(result).toBe("1│ single line");
  });

  it("should handle empty content", () => {
    const content = "";
    const result = addLineNumbers(content);

    expect(result).toBe("1│ ");
  });

  it("should pad correctly when starting from high numbers", () => {
    const content = "line 1\nline 2";
    const result = addLineNumbers(content, 998);

    expect(result).toBe("998│ line 1\n999│ line 2");
  });
});

describe("filterByLineRange", () => {
  it("should filter lines within range", () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5";
    const result = filterByLineRange(content, 2, 4);

    expect(result).toBe("line 2\nline 3\nline 4");
  });

  it("should handle start line 1", () => {
    const content = "line 1\nline 2\nline 3";
    const result = filterByLineRange(content, 1, 2);

    expect(result).toBe("line 1\nline 2");
  });

  it("should handle range extending to end", () => {
    const content = "line 1\nline 2\nline 3";
    const result = filterByLineRange(content, 2, 5);

    expect(result).toBe("line 2\nline 3");
  });

  it("should handle range starting beyond content length", () => {
    const content = "line 1\nline 2\nline 3";
    const result = filterByLineRange(content, 10, 20);

    expect(result).toBe("");
  });

  it("should handle negative start line (clamps to 0)", () => {
    const content = "line 1\nline 2\nline 3";
    const result = filterByLineRange(content, -5, 2);

    expect(result).toBe("line 1\nline 2");
  });

  it("should return single line when start equals end", () => {
    const content = "line 1\nline 2\nline 3";
    const result = filterByLineRange(content, 2, 2);

    expect(result).toBe("line 2");
  });

  it("should handle entire content", () => {
    const content = "line 1\nline 2\nline 3";
    const result = filterByLineRange(content, 1, 3);

    expect(result).toBe("line 1\nline 2\nline 3");
  });
});

describe("buildSubjectsMarkdown", () => {
  it("should build markdown for subject with title only", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toBe("# Test Subject\n\n");
  });

  it("should include description when present", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "This is a test description.",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("# Test Subject");
    expect(result).toContain("This is a test description.");
  });

  it("should include imports block when present", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: 'import { x } from "y";',
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("### Imports");
    expect(result).toContain("```typescript");
    expect(result).toContain('import { x } from "y";');
    expect(result).toContain("```");
  });

  it("should include prelude blocks when present", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [
          { code: "const schema = {};", id: "schema" },
          { code: "const config = {};", id: "config" },
        ],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("### Prelude");
    expect(result).toContain("const schema = {};");
    expect(result).toContain("const config = {};");
    // Should have multiple code blocks
    expect(result.split("```typescript").length).toBe(3); // One opening for each block
  });

  it("should include sections with content", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [
          {
            heading: "Basic Usage",
            content: "This is how you use it.\n\n```typescript\nconst x = 1;\n```",
          },
          {
            heading: "Advanced Usage",
            content: "This is advanced usage.",
          },
        ],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("## Basic Usage");
    expect(result).toContain("This is how you use it.");
    expect(result).toContain("## Advanced Usage");
    expect(result).toContain("This is advanced usage.");
  });

  it("should build markdown for multiple subjects", () => {
    const subjects: Subject[] = [
      {
        id: "subject-1",
        title: "Subject 1",
        description: "First subject",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
      {
        id: "subject-2",
        title: "Subject 2",
        description: "Second subject",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("# Subject 1");
    expect(result).toContain("First subject");
    expect(result).toContain("# Subject 2");
    expect(result).toContain("Second subject");
  });

  it("should build complete markdown with all components", () => {
    const subjects: Subject[] = [
      {
        id: "complete-subject",
        title: "Complete Subject",
        description: "A complete example",
        imports: 'import { defineRoute } from "@fragno-dev/core";',
        prelude: [{ code: "const schema = {};", id: "schema" }],
        testInit: [],
        examples: [
          {
            code: "const example = 1;",
            explanation: "Example explanation",
            id: "example-1",
          },
        ],
        sections: [
          {
            heading: "Usage",
            content: "Usage information here",
          },
        ],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("# Complete Subject");
    expect(result).toContain("A complete example");
    expect(result).toContain("### Imports");
    expect(result).toContain('import { defineRoute } from "@fragno-dev/core";');
    expect(result).toContain("### Prelude");
    expect(result).toContain("const schema = {};");
    expect(result).toContain("## Usage");
    expect(result).toContain("Usage information here");
  });
});

describe("buildSubjectsMarkdown - code blocks", () => {
  it("should properly format code blocks in sections", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [
          {
            code: "const x = 1;\nconst y = 2;",
            explanation: "Example with multiline code",
            id: "example-1",
          },
        ],
        sections: [
          {
            heading: "Examples",
            content:
              "Here's an example:\n\n```typescript\nconst x = 1;\nconst y = 2;\n```\n\nThat's the example.",
          },
        ],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("## Examples");
    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("const y = 2;");
  });

  it("should handle sections with special markdown characters", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [
          {
            heading: "Special Characters",
            content: "Text with **bold** and *italic* and `code` inline.",
          },
        ],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("**bold**");
    expect(result).toContain("*italic*");
    expect(result).toContain("`code`");
  });

  it("should handle nested lists in sections", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [
          {
            heading: "Lists",
            content: "- Item 1\n- Item 2\n  - Nested item\n- Item 3",
          },
        ],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
    expect(result).toContain("  - Nested item");
    expect(result).toContain("- Item 3");
  });

  it("should handle code blocks with different languages", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [
          {
            heading: "Multi-language Examples",
            content: "TypeScript:\n\n```typescript\nconst x = 1;\n```\n\nJSON:\n\n```json\n{}\n```",
          },
        ],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("```typescript");
    expect(result).toContain("```json");
  });

  it("should preserve code block indentation", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [
          {
            code: "function test() {\n  const x = 1;\n  return x;\n}",
            id: "test-fn",
          },
        ],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = buildSubjectsMarkdown(subjects);
    expect(result).toContain("  const x = 1;");
    expect(result).toContain("  return x;");
  });
});

describe("addLineNumbers - edge cases", () => {
  it("should handle very long lines without breaking", () => {
    const longLine = "a".repeat(1000);
    const content = `short line\n${longLine}\nshort line`;
    const result = addLineNumbers(content);

    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(longLine);
    expect(lines[1]).toMatch(/^2│/);
  });

  it("should handle lines with tabs", () => {
    const content = "line 1\n\tindented line\n\t\tdoubly indented";
    const result = addLineNumbers(content);

    expect(result).toContain("1│ line 1");
    expect(result).toContain("2│ \tindented line");
    expect(result).toContain("3│ \t\tdoubly indented");
  });

  it("should handle unicode characters", () => {
    const content = "Hello 世界\nمرحبا\n🎉";
    const result = addLineNumbers(content);

    expect(result).toContain("1│ Hello 世界");
    expect(result).toContain("2│ مرحبا");
    expect(result).toContain("3│ 🎉");
  });

  it("should handle content with only newlines", () => {
    const content = "\n\n\n";
    const result = addLineNumbers(content);

    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("1│ ");
    expect(lines[1]).toBe("2│ ");
    expect(lines[2]).toBe("3│ ");
    expect(lines[3]).toBe("4│ ");
  });

  it("should pad consistently for very large line numbers", () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = addLineNumbers(content);

    const lines = result.split("\n");
    // All lines should start with 4 digits + │
    for (const line of lines) {
      expect(line).toMatch(/^\s{0,3}\d{1,4}│/);
    }

    // First line should have 3 spaces of padding
    expect(lines[0]).toMatch(/^\s{3}1│/);
    // Line 1000 should have no padding
    expect(lines[999]).toMatch(/^1000│/);
  });
});

describe("filterByLineRange - edge cases", () => {
  it("should handle Windows-style line endings", () => {
    const content = "line 1\r\nline 2\r\nline 3";
    const result = filterByLineRange(content, 2, 2);

    // The split will include the \r
    expect(result).toContain("line 2");
  });

  it("should handle empty lines at boundaries", () => {
    const content = "\nline 2\n\nline 4\n";
    const result = filterByLineRange(content, 2, 4);

    expect(result).toBe("line 2\n\nline 4");
  });

  it("should handle single character per line", () => {
    const content = "a\nb\nc\nd";
    const result = filterByLineRange(content, 2, 3);

    expect(result).toBe("b\nc");
  });

  it("should preserve whitespace-only lines", () => {
    const content = "line 1\n   \nline 3";
    const result = filterByLineRange(content, 1, 3);

    expect(result).toBe("line 1\n   \nline 3");
  });
});

describe("extractHeadingsAndBlocks", () => {
  it("should extract title with line number", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("1│ # Test Subject");
  });

  it("should show instruction header", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("Use --start N --end N flags to show specific line ranges");
  });

  it("should include description with line numbers", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "This is a description.",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("This is a description.");
    // Should have line numbers
    expect(result).toMatch(/\d+│ This is a description\./);
  });

  it("should show imports heading with line number", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: 'import { x } from "y";',
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("### Imports");
    expect(result).toMatch(/\d+│ ### Imports/);
  });

  it("should list prelude blocks with IDs and line ranges", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [
          { code: "const schema = {};", id: "schema" },
          { code: "const config = {\n  key: 'value'\n};", id: "config" },
        ],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("### Prelude");
    expect(result).toContain("- id: `schema`");
    expect(result).toContain("- id: `config`");
    // Should show line ranges
    expect(result).toMatch(/- id: `schema`, L\d+-\d+/);
    expect(result).toMatch(/- id: `config`, L\d+-\d+/);
  });

  it("should extract section headings with line numbers", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [
          {
            heading: "Basic Usage",
            content: "Content here",
          },
          {
            heading: "Advanced Usage",
            content: "More content",
          },
        ],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toMatch(/\d+│ ## Basic Usage/);
    expect(result).toMatch(/\d+│ ## Advanced Usage/);
  });

  it("should handle multiline descriptions", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "Line 1 of description\nLine 2 of description\nLine 3 of description",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("Line 1 of description");
    expect(result).toContain("Line 2 of description");
    expect(result).toContain("Line 3 of description");
    // Each line should have a line number
    const lines = result.split("\n").filter((line) => line.includes("of description"));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/\d+│/);
    }
  });

  it("should show empty lines with line numbers", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    // There should be an empty line after title with line number
    expect(result).toMatch(/2│\s*$/m);
  });

  it("should handle subjects without prelude or imports", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "Simple description",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [
          {
            heading: "Section 1",
            content: "Content",
          },
        ],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("# Test Subject");
    expect(result).toContain("Simple description");
    expect(result).toContain("## Section 1");
    expect(result).not.toContain("### Imports");
    expect(result).not.toContain("### Prelude");
  });

  it("should handle multiple subjects", () => {
    const subjects: Subject[] = [
      {
        id: "subject-1",
        title: "Subject 1",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
      {
        id: "subject-2",
        title: "Subject 2",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("# Subject 1");
    expect(result).toContain("# Subject 2");
  });

  it("should pad line numbers consistently", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: Array.from({ length: 20 }, (_, i) => ({
          heading: `Section ${i + 1}`,
          content: "Some content",
        })),
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    const lines = result.split("\n");
    // Find lines with content (not just the header)
    const numberedLines = lines.filter((line) => /^\s*\d+│/.test(line));

    // Check that all line numbers have consistent padding
    const lineNumbers = numberedLines.map((line) => {
      const match = line.match(/^(\s*\d+)│/);
      return match ? match[1] : "";
    });

    // All line number parts should have the same length
    const lengths = lineNumbers.map((num) => num.length);
    const maxLength = Math.max(...lengths);
    for (const length of lengths) {
      expect(length).toBe(maxLength);
    }
  });

  it("should handle prelude blocks without IDs", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: "",
        prelude: [
          { code: "const x = 1;", id: undefined },
          { code: "const y = 2;", id: "with-id" },
        ],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("- id: `(no-id)`");
    expect(result).toContain("- id: `with-id`");
  });

  it("should calculate correct line ranges for imports code", () => {
    const subjects: Subject[] = [
      {
        id: "test-subject",
        title: "Test Subject",
        description: "",
        imports: 'import { a } from "a";\nimport { b } from "b";',
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    // Should show imports section
    expect(result).toContain("### Imports");
    // Should show the code fence line
    expect(result).toContain("```typescript");
  });
});

describe("integration - line numbers with filtering", () => {
  it("should correctly filter and then add line numbers", () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5";

    // Filter to lines 2-4
    const filtered = filterByLineRange(content, 2, 4);
    expect(filtered).toBe("line 2\nline 3\nline 4");

    // Add line numbers starting from 2
    const numbered = addLineNumbers(filtered, 2);
    expect(numbered).toBe("2│ line 2\n3│ line 3\n4│ line 4");
  });

  it("should handle filtering single line then adding line numbers", () => {
    const content = "line 1\nline 2\nline 3";

    const filtered = filterByLineRange(content, 2, 2);
    const numbered = addLineNumbers(filtered, 2);

    expect(numbered).toBe("2│ line 2");
  });

  it("should preserve content integrity through filter and number pipeline", () => {
    const content = Array.from({ length: 50 }, (_, i) => `content line ${i + 1}`).join("\n");

    // Filter middle section
    const filtered = filterByLineRange(content, 20, 30);
    const lines = filtered.split("\n");
    expect(lines).toHaveLength(11); // 20 through 30 inclusive

    // Add line numbers
    const numbered = addLineNumbers(filtered, 20);
    const numberedLines = numbered.split("\n");

    // Verify first and last lines
    expect(numberedLines[0]).toContain("20│ content line 20");
    expect(numberedLines[10]).toContain("30│ content line 30");
  });
});

describe("integration - markdown building with special content", () => {
  it("should handle subjects with all possible components", () => {
    const subjects: Subject[] = [
      {
        id: "full-subject",
        title: "Complete Test Subject",
        description: "First line\nSecond line\nThird line",
        imports: 'import { x } from "x";\nimport { y } from "y";',
        prelude: [
          { code: "const schema = {};", id: "schema" },
          { code: "const config = {\n  key: 'value'\n};", id: "config" },
        ],
        testInit: [{ code: "setup();" }],
        examples: [
          {
            code: "const example1 = 1;",
            explanation: "First example",
            id: "ex1",
          },
          {
            code: "const example2 = 2;",
            explanation: "Second example",
            id: "ex2",
          },
        ],
        sections: [
          {
            heading: "Getting Started",
            content: "Introduction paragraph.\n\nMore details here.",
          },
          {
            heading: "Advanced Usage",
            content: "Advanced content with code:\n\n```typescript\nadvanced code;\n```",
          },
        ],
      },
    ];

    const markdown = buildSubjectsMarkdown(subjects);

    // Verify all components are present
    expect(markdown).toContain("# Complete Test Subject");
    expect(markdown).toContain("First line\nSecond line\nThird line");
    expect(markdown).toContain("### Imports");
    expect(markdown).toContain('import { x } from "x";');
    expect(markdown).toContain("### Prelude");
    expect(markdown).toContain("const schema = {};");
    expect(markdown).toContain("const config");
    expect(markdown).toContain("## Getting Started");
    expect(markdown).toContain("## Advanced Usage");

    // Verify structure - title should come before sections
    const titleIndex = markdown.indexOf("# Complete Test Subject");
    const sectionIndex = markdown.indexOf("## Getting Started");
    expect(titleIndex).toBeLessThan(sectionIndex);
  });

  it("should build consistent markdown for empty subjects", () => {
    const subjects: Subject[] = [
      {
        id: "empty",
        title: "Empty Subject",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const markdown = buildSubjectsMarkdown(subjects);
    expect(markdown).toBe("# Empty Subject\n\n");
  });

  it("should properly separate multiple subjects in markdown", () => {
    const subjects: Subject[] = [
      {
        id: "first",
        title: "First Subject",
        description: "First description",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
      {
        id: "second",
        title: "Second Subject",
        description: "Second description",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [],
      },
    ];

    const markdown = buildSubjectsMarkdown(subjects);

    // Both subjects should be present
    expect(markdown).toContain("# First Subject");
    expect(markdown).toContain("# Second Subject");

    // They should be in order
    const firstIndex = markdown.indexOf("# First Subject");
    const secondIndex = markdown.indexOf("# Second Subject");
    expect(firstIndex).toBeLessThan(secondIndex);
  });
});

describe("edge cases - line number display width", () => {
  it("should handle transition from 9 to 10 lines correctly", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = addLineNumbers(content);

    const lines = result.split("\n");
    // Lines 1-9 should have 1 space padding
    expect(lines[0]).toMatch(/^ 1│/);
    expect(lines[8]).toMatch(/^ 9│/);
    // Line 10 should have no padding
    expect(lines[9]).toMatch(/^10│/);
  });

  it("should handle transition from 99 to 100 lines correctly", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = addLineNumbers(content);

    const lines = result.split("\n");
    // Lines 1-9 should have 2 spaces
    expect(lines[0]).toMatch(/^ {2}1│/);
    // Lines 10-99 should have 1 space
    expect(lines[9]).toMatch(/^ 10│/);
    expect(lines[98]).toMatch(/^ 99│/);
    // Line 100 should have no padding
    expect(lines[99]).toMatch(/^100│/);
  });

  it("should handle transition from 999 to 1000 lines correctly", () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = addLineNumbers(content);

    const lines = result.split("\n");
    // Line 1 should have 3 spaces
    expect(lines[0]).toMatch(/^ {3}1│/);
    // Line 999 should have no padding
    expect(lines[998]).toMatch(/^ 999│/);
    // Line 1000 should have no padding
    expect(lines[999]).toMatch(/^1000│/);
  });
});

describe("extractHeadingsAndBlocks - complex scenarios", () => {
  it("should handle examples that match sections", () => {
    const subjects: Subject[] = [
      {
        id: "test",
        title: "Test",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [
          {
            code: "const user = { name: 'John' };",
            explanation: "Create a user",
            id: "create-user",
          },
        ],
        sections: [
          {
            heading: "User Management",
            content:
              "Here's how to create a user:\n\n```typescript\nconst user = { name: 'John' };\n```",
          },
        ],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("## User Management");
    expect(result).toContain("- id: `create-user`");
  });

  it("should handle sections with no matching examples", () => {
    const subjects: Subject[] = [
      {
        id: "test",
        title: "Test",
        description: "",
        imports: "",
        prelude: [],
        testInit: [],
        examples: [],
        sections: [
          {
            heading: "Overview",
            content: "This is just text, no code examples.",
          },
        ],
      },
    ];

    const result = extractHeadingsAndBlocks(subjects);
    expect(result).toContain("## Overview");
    // Should not have any example IDs listed
    expect(result).not.toContain("- id:");
  });
});
