#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { create, createOptionsSchema } from "@fragno-dev/create";
import * as p from "@clack/prompts";

function isInteractive() {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      !process.env["CI"] &&
      process.env["TERM"] !== "dumb",
  );
}

const main = defineCommand({
  meta: {
    name: "create",
    description: "Create a Fragno project from template",
    version: process.env["npm_package_version"],
  },
  args: {
    "non-interactive": {
      type: "boolean",
      description: "Run in non-interactive mode (no prompts)",
      default: false,
    },
    name: {
      type: "string",
      description: "Project name (required in non-interactive mode)",
    },
    path: {
      type: "string",
      description: "Project path (default: ./<name>)",
    },
    template: {
      type: "string",
      description: "Template to use (default: fragment)",
      default: "fragment",
    },
    "build-tool": {
      type: "string",
      description:
        "Build tool (tsdown, vite, esbuild, rollup, webpack, rspack, none; default: tsdown)",
      default: "tsdown",
    },
    "agent-docs": {
      type: "string",
      description: "Agent docs to include (AGENTS.md, CLAUDE.md, none; default: none)",
      default: "none",
    },
    "with-database": {
      type: "boolean",
      description: "Include database layer (default: true)",
      default: true,
    },
  },
  async run({ args }) {
    if (args["non-interactive"]) {
      if (!args.name) {
        console.error("Error: --name is required in non-interactive mode.");
        process.exit(1);
      }

      const options = createOptionsSchema.safeParse({
        name: args.name,
        path: args.path ?? `./${args.name}`,
        template: args.template,
        buildTool: args["build-tool"],
        agentDocs: args["agent-docs"],
        withDatabase: args["with-database"],
      });

      if (!options.success) {
        console.error("Invalid options:", options.error.format());
        process.exit(1);
      }

      create(options.data);
      console.log("Project created successfully!");
      return;
    }

    // Interactive mode
    if (!isInteractive()) {
      p.cancel("Cannot run in non-interactive terminal. Use --non-interactive flag instead.");
      process.exit(1);
    }

    p.intro(`░█▀▀░█▀▄░█▀█░█▀▀░█▀█░█▀█
│  ░█▀▀░█▀▄░█▀█░█░█░█░█░█░█
│  ░▀░░░▀░▀░▀░▀░▀▀▀░▀░▀░▀▀▀`);

    const template = await p.select({
      message: "Pick a template",
      options: [{ value: "fragment", label: "Fragment" }],
    });

    if (p.isCancel(template)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const name = await p.text({
      message: "What is your project name?",
      placeholder: "my-fragment",
      validate(value) {
        if (value.length === 0) {
          return "Project name is required!";
        }
        return undefined;
      },
    });

    if (p.isCancel(name)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const projectPath = await p.text({
      message: "Where should we create your project?",
      placeholder: `./${name}`,
      initialValue: `./${name}`,
    });

    if (p.isCancel(projectPath)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const buildTool = await p.select({
      message: "Pick a build tool",
      options: [
        { value: "tsdown", label: "tsdown (recommended)" },
        { value: "vite", label: "vite" },
        { value: "esbuild", label: "esbuild" },
        { value: "rollup", label: "rollup" },
        { value: "webpack", label: "webpack" },
        { value: "rspack", label: "rspack" },
        { value: "none", label: "none (bring your own)" },
      ],
      initialValue: "tsdown",
    });

    if (p.isCancel(buildTool)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const agent = await p.select({
      message: "Add AI Agent README?",
      options: [
        { value: "AGENTS.md", label: "AGENTS.md (for Cursor, Codex and more)" },
        { value: "CLAUDE.md", label: "CLAUDE.md (for Claude Code)" },
        { value: "none", label: "skip" },
      ],
      initialValue: "AGENTS.md",
    });

    if (p.isCancel(agent)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const withDatabase = await p.select({
      message: "Include database layer?",
      options: [
        { value: true, label: "Yes" },
        { value: false, label: "No (skip)" },
      ],
      initialValue: false,
    });

    if (p.isCancel(withDatabase)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const options = createOptionsSchema.safeParse({
      name: name,
      path: projectPath,
      template: template,
      buildTool: buildTool,
      agentDocs: agent,
      withDatabase: withDatabase,
    });

    if (!options.success) {
      p.cancel("Invalid options!");
      process.exit(1);
    }

    create(options.data);

    p.outro("Project created successfully!");
  },
});

runMain(main);
