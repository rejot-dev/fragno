import { defineCommand, runMain } from "citty";
import { create } from "@fragno-dev/create";
import * as p from "@clack/prompts";

const main = defineCommand({
  meta: {
    name: "create",
    description: "Interactively create project from template",
    version: process.env["npm_package_version"],
  },
  async run() {
    p.intro("@fragno-dev/create");

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

    const template = await p.select({
      message: "Pick a template",
      options: [{ value: "fragment", label: "Fragment" }],
    });

    if (p.isCancel(template)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const buildTool = await p.select({
      message: "Pick a build tool",
      options: [
        { value: "vite", label: "vite" },
        { value: "tsdown", label: "tsdown" },
        { value: "esbuild", label: "esbuild" },
        { value: "rollup", label: "rollup" },
        { value: "webpack", label: "webpack" },
        { value: "rspack", label: "rspack" },
        { value: "none", label: "None (bring your own)" },
      ],
    });

    if (p.isCancel(buildTool)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    create({
      name: name,
      path: projectPath,
      template: template,
      buildTool: buildTool,
    });

    p.outro("Project created successfully!");
  },
});

runMain(main);
