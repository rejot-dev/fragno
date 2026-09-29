import { assert, it } from "vitest";

import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";

import express from "express";

import { registerNodeBackofficeWorkerSourceMaps } from "./node-worker-source-maps";

it.each([true, false])(
  "serves OPFS worker maps only for local Node launches (enabled: %s)",
  async (enabled) => {
    const assetsUrl = new URL(
      "../assets/",
      import.meta.resolve("@tanstack/browser-db-sqlite-persistence"),
    );
    const sourceMapName = (await readdir(assetsUrl)).find(
      (name) => name.startsWith("opfs-worker-") && name.endsWith(".js.map"),
    );
    assert(sourceMapName);

    const app = express();
    registerNodeBackofficeWorkerSourceMaps(app, enabled);
    app.use((_request, response) => response.sendStatus(404));
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}/assets/`;
      const response = await fetch(new URL(sourceMapName, baseUrl));
      assert.equal(response.status, enabled ? 200 : 404);
      if (enabled) {
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(
          await response.text(),
          await readFile(new URL(sourceMapName, assetsUrl), "utf8"),
        );
      } else {
        await response.text();
      }

      // The debug route must not expose other files from the dependency's assets directory.
      const workerResponse = await fetch(new URL(sourceMapName.replace(/\.map$/, ""), baseUrl));
      assert.equal(workerResponse.status, 404);
      await workerResponse.text();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  },
);
