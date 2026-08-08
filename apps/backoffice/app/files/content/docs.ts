import type { FileContent } from "../interface";

const docModules = import.meta.glob<string>("../../../content/static/docs/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const STATIC_DOC_CONTENT: Record<string, FileContent> = Object.fromEntries(
  Object.entries(docModules).map(([path, content]) => [
    path.replace("../../../content/static/", ""),
    content,
  ]),
);
