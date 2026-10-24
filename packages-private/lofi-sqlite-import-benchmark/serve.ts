// Serves a production build and the recorded outbox without Vite, so the benchmark runs on a
// machine with only Node: `node serve.ts <build directory> <outbox.jsonl> [port]`.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

import { createOutboxFixtureHandler } from "./outbox-fixture-server.ts";

const [buildDirectory, fixturePath, port = "5544"] = process.argv.slice(2);
if (!buildDirectory || !fixturePath) {
  throw new Error("Usage: node serve.ts <build directory> <outbox.jsonl> [port]");
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const serveFixture = createOutboxFixtureHandler(fixturePath, console.log);
createServer((request, response) => {
  serveFixture(request, response, () => {
    const pathname = new URL(request.url ?? "/", "http://build").pathname;
    // `normalize` resolves `..` segments, so a request cannot leave the build directory.
    const file = join(buildDirectory, normalize(pathname === "/" ? "/index.html" : pathname));
    readFile(file).then(
      (body) => {
        response.setHeader(
          "Content-Type",
          contentTypes[extname(file)] ?? "application/octet-stream",
        );
        response.end(body);
      },
      () => {
        response.statusCode = 404;
        response.end();
      },
    );
  });
}).listen(Number(port), () => {
  console.log(`Serving ${buildDirectory} on http://localhost:${port}`);
});
