import type { FileContent } from "../interface";

const codemodeTypeModules = import.meta.glob<string>("../../../content/static/codemode/**/*.d.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** Build-generated and authored codemode declarations bundled into the static file collection. */
export const STATIC_CODEMODE_CONTENT: Record<string, FileContent> = Object.fromEntries(
  Object.entries(codemodeTypeModules).map(([path, content]) => [
    path.replace("../../../content/static/", ""),
    content,
  ]),
);
