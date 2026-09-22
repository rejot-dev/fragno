import type { FileContent } from "../interface";

const skillModules = import.meta.glob<string>("../../../content/static/skills/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const GENERAL_SKILL_CONTENT: Record<string, FileContent> = Object.fromEntries(
  Object.entries(skillModules).map(([path, content]) => [
    path.replace("../../../content/static/", ""),
    content,
  ]),
);
