import { describe, expect, it } from "vitest";

import {
  createPiSkillActivationTool,
  renderPiSkillCatalogXml,
  renderPiSkillInvocationContext,
  type PiSkillDefinition,
} from "./skills";

describe("renderPiSkillInvocationContext", () => {
  it("renders skill invocation XML with explicit directory, relative resource note, and extra instructions", () => {
    expect(
      renderPiSkillInvocationContext(
        {
          name: "pdf-processing",
          description: "Use when working with PDF files.",
          body: "Read the PDF handling reference before editing scripts.",
          directory: "/home/user/.agents/skills/pdf-processing",
          location: "/home/user/.agents/skills/pdf-processing/SKILL.md",
          resources: [
            { path: "scripts/extract.py", description: "Extract text from a PDF." },
            { path: "references/pdf-spec-summary.md", mimeType: "text/markdown" },
          ],
        },
        { extraUserInstructions: "Only summarize the extraction risks." },
      ),
    ).toBe(`<skill_content name="pdf-processing">
<name>pdf-processing</name>
<description>Use when working with PDF files.</description>
<body>
Read the PDF handling reference before editing scripts.
</body>
<directory>/home/user/.agents/skills/pdf-processing</directory>
<location>/home/user/.agents/skills/pdf-processing/SKILL.md</location>
<resource_path_note>Resource file paths are relative to the skill itself.</resource_path_note>
<skill_resources>
    <file>
      <path>scripts/extract.py</path>
      <description>Extract text from a PDF.</description>
    </file>
    <file>
      <path>references/pdf-spec-summary.md</path>
      <mimeType>text/markdown</mimeType>
    </file>
</skill_resources>
</skill_content>

Only summarize the extraction risks.`);
  });

  it("omits the trailing instructions block when no extra user instructions are provided", () => {
    expect(
      renderPiSkillInvocationContext({
        name: "fragno",
        description: "Use when working on Fragno fragments.",
      }),
    ).toBe(`<skill_content name="fragno">
<name>fragno</name>
<description>Use when working on Fragno fragments.</description>
</skill_content>`);
  });
});

describe("createPiSkillActivationTool", () => {
  it("creates the built-in activate_skill tool", () => {
    const tool = createPiSkillActivationTool({});

    expect(tool.name).toBe("activate_skill");
    expect(tool.label).toBe("Activate skill");
    expect(tool.description).toBe("Load the full instructions for a registered Pi skill by name.");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  it("allows overriding tool metadata", () => {
    const tool = createPiSkillActivationTool(
      {},
      {
        name: "load_skill",
        label: "Load skill",
        description: "Load a skill.",
      },
    );

    expect(tool.name).toBe("load_skill");
    expect(tool.label).toBe("Load skill");
    expect(tool.description).toBe("Load a skill.");
  });

  it("activates a skill by returning wrapped skill content", async () => {
    const tool = createPiSkillActivationTool({
      fragno: {
        name: "fragno",
        description: "Use when working on Fragno fragments.",
        body: "Follow Fragno conventions.",
        location: "/repo/.agents/skills/fragno/SKILL.md",
        resources: [
          {
            path: "references/fragment-authoring.md",
            description: "Fragment authoring reference.",
            content: "Do not include resource content eagerly.",
            mimeType: "text/markdown",
          },
        ],
      },
    });

    await expect(tool.execute("call-1", { name: "fragno" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: `<skill_content name="fragno">
<name>fragno</name>
<description>Use when working on Fragno fragments.</description>
<body>
Follow Fragno conventions.
</body>
<directory>/repo/.agents/skills/fragno</directory>
<location>/repo/.agents/skills/fragno/SKILL.md</location>
<resource_path_note>Resource file paths are relative to the skill itself.</resource_path_note>
<skill_resources>
    <file>
      <path>references/fragment-authoring.md</path>
      <description>Fragment authoring reference.</description>
      <mimeType>text/markdown</mimeType>
    </file>
</skill_resources>
</skill_content>`,
        },
      ],
      details: { found: true, name: "fragno", resourceCount: 1 },
    });
  });

  it("activates skills from an array", async () => {
    const tool = createPiSkillActivationTool([
      { name: "fragno", description: "Use when working on Fragno fragments." },
    ]);

    await expect(tool.execute("call-1", { name: "fragno" })).resolves.toMatchObject({
      details: { found: true, name: "fragno", resourceCount: 0 },
    });
  });

  it("escapes XML special characters in activated skill content", async () => {
    const tool = createPiSkillActivationTool([
      {
        name: `fragno<&>"'`,
        description: `Use <skills> & explain "quotes" and 'apostrophes'.`,
        body: `Read <body> & preserve "quotes".`,
        location: `/repo/<skill>.md`,
        resources: [
          {
            path: `references/<guide>.md`,
            description: `Guide & "notes".`,
            mimeType: `text/<markdown>`,
          },
        ],
      },
    ]);

    await expect(tool.execute("call-1", { name: `fragno<&>"'` })).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: `<skill_content name="fragno&lt;&amp;&gt;&quot;&apos;">
<name>fragno&lt;&amp;&gt;&quot;&apos;</name>
<description>Use &lt;skills&gt; &amp; explain &quot;quotes&quot; and &apos;apostrophes&apos;.</description>
<body>
Read &lt;body&gt; &amp; preserve &quot;quotes&quot;.
</body>
<directory>/repo</directory>
<location>/repo/&lt;skill&gt;.md</location>
<resource_path_note>Resource file paths are relative to the skill itself.</resource_path_note>
<skill_resources>
    <file>
      <path>references/&lt;guide&gt;.md</path>
      <description>Guide &amp; &quot;notes&quot;.</description>
      <mimeType>text/&lt;markdown&gt;</mimeType>
    </file>
</skill_resources>
</skill_content>`,
        },
      ],
    });
  });

  it("returns an error result when the requested skill does not exist", async () => {
    const tool = createPiSkillActivationTool({});

    await expect(tool.execute("call-1", { name: "missing" })).resolves.toEqual({
      content: [{ type: "text", text: "Skill 'missing' was not found." }],
      details: { found: false, name: "missing" },
      isError: true,
    });
  });
});

describe("renderPiSkillCatalogXml", () => {
  it("renders an empty string when no skills are available", () => {
    expect(renderPiSkillCatalogXml({})).toBe("");
    expect(renderPiSkillCatalogXml([])).toBe("");
  });

  it("renders the fixed skill catalog XML shape", () => {
    expect(
      renderPiSkillCatalogXml({
        fragno: {
          name: "fragno",
          description: "Use when working on Fragno fragments.",
        },
      }),
    ).toBe(`<available_skills>
  <skill>
    <name>fragno</name>
    <description>Use when working on Fragno fragments.</description>
  </skill>
</available_skills>`);
  });

  it("renders skills in deterministic name order", () => {
    const skills = {
      zebra: { name: "zebra", description: "Last." },
      alpha: { name: "alpha", description: "First." },
      middle: { name: "middle", description: "Middle." },
    } satisfies Record<string, PiSkillDefinition>;

    expect(renderPiSkillCatalogXml(skills)).toBe(`<available_skills>
  <skill>
    <name>alpha</name>
    <description>First.</description>
  </skill>
  <skill>
    <name>middle</name>
    <description>Middle.</description>
  </skill>
  <skill>
    <name>zebra</name>
    <description>Last.</description>
  </skill>
</available_skills>`);
  });

  it("accepts an array of skill definitions", () => {
    const skills = [
      { name: "second", description: "Second skill." },
      { name: "first", description: "First skill." },
    ] satisfies PiSkillDefinition[];

    expect(renderPiSkillCatalogXml(skills)).toBe(`<available_skills>
  <skill>
    <name>first</name>
    <description>First skill.</description>
  </skill>
  <skill>
    <name>second</name>
    <description>Second skill.</description>
  </skill>
</available_skills>`);
  });

  it("escapes XML special characters in names and descriptions", () => {
    expect(
      renderPiSkillCatalogXml([
        {
          name: `fragno<&>"'`,
          description: `Use <skills> & explain "quotes" and 'apostrophes'.`,
        },
      ]),
    ).toBe(`<available_skills>
  <skill>
    <name>fragno&lt;&amp;&gt;&quot;&apos;</name>
    <description>Use &lt;skills&gt; &amp; explain &quot;quotes&quot; and &apos;apostrophes&apos;.</description>
  </skill>
</available_skills>`);
  });

  it("does not include skill bodies, paths, resources, or metadata", () => {
    expect(
      renderPiSkillCatalogXml([
        {
          name: "fragno",
          description: "Use when working on Fragno fragments.",
          body: "Do not eagerly include this instruction body.",
          location: "/repo/.agents/skills/fragno/SKILL.md",
          resources: [
            {
              path: "references/details.md",
              description: "Do not eagerly include this resource.",
              content: "Do not include this content.",
              mimeType: "text/markdown",
            },
          ],
          metadata: { source: "manual" },
        },
      ]),
    ).toBe(`<available_skills>
  <skill>
    <name>fragno</name>
    <description>Use when working on Fragno fragments.</description>
  </skill>
</available_skills>`);
  });
});
