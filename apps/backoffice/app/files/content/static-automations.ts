import type { FileContent } from "../interface";

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
