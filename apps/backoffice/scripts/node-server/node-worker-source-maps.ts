import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Express } from "express";

/** Serves installed OPFS worker debug maps locally without copying them into build artifacts. */
export function registerNodeBackofficeWorkerSourceMaps(app: Express, enabled: boolean): void {
  if (!enabled) {
    return;
  }

  const assetsUrl = new URL(
    "../assets/",
    import.meta.resolve("@tanstack/browser-db-sqlite-persistence"),
  );
  for (const name of readdirSync(assetsUrl)) {
    if (name.startsWith("opfs-worker-") && name.endsWith(".js.map")) {
      app.get(`/assets/${name}`, (_request, response) => {
        response.sendFile(name, {
          root: fileURLToPath(assetsUrl),
          cacheControl: false,
          headers: { "Cache-Control": "no-store" },
        });
      });
    }
  }
}
