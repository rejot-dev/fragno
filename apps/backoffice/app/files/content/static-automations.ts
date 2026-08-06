import type { FileContent } from "../interface";

export const STATIC_AUTOMATION_SCRIPT_PATHS = {
  projectFilesConfigure: "automations/project-files-configure.workflow.js",
} as const;

const automationModules = import.meta.glob<string>("../../../content/static/automations/**/*.js", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const STATIC_AUTOMATION_CONTENT: Record<string, FileContent> = Object.fromEntries(
  Object.entries(automationModules).map(([path, content]) => [
    path.replace("../../../content/static/", ""),
    content,
  ]),
);
