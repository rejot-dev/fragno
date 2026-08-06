import type { FileContent } from "../interface";
import { GENERATING_BACKOFFICE_UIS_SKILL_CONTENT } from "./generating-backoffice-uis-skill";

const skillModules = import.meta.glob<string>("../../../content/static/skills/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const GENERAL_SKILL_CONTENT: Record<string, FileContent> = {
  ...Object.fromEntries(
    Object.entries(skillModules).map(([path, content]) => [
      path.replace("../../../content/static/", ""),
      content,
    ]),
  ),
  ...GENERATING_BACKOFFICE_UIS_SKILL_CONTENT,
};
