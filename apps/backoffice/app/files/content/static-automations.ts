const automationModules = import.meta.glob<string>("../../../content/static/automations/**/*.js", {
  eager: true,
  query: "?raw",
  import: "default",
});

export const STATIC_AUTOMATION_CONTENT: Record<string, string | Uint8Array> = Object.fromEntries(
  Object.entries(automationModules).map(([path, content]) => [
    path.replace("../../../content/static/", ""),
    content,
  ]),
);
