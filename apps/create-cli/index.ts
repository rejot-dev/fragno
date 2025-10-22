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
    description: "Interactively create project from template",
    version: process.env["npm_package_version"],
  },
  async run() {
    p.intro(`░█▀▀░█▀▄░█▀█░█▀▀░█▀█░█▀█
│  ░█▀▀░█▀▄░█▀█░█░█░█░█░█░█
│  ░▀░░░▀░▀░▀░▀░▀▀▀░▀░▀░▀▀▀`);

    // TODO: allow to pass all options through args
    if (!isInteractive()) {
      p.cancel("Cannot run CLI in non-interactive mode.");
      process.exit(1);
    }

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
        if (value.length === 0) return "Project name is required!";
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
