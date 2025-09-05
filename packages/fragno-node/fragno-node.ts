import type { RequestListener } from "node:http";
import { createRequestListener } from "@remix-run/node-fetch-server";

/**
 * Creates a handler that can be used with `node:http` to serve backend requests based on a Fragno
 * fragment (library).
 *
 * @example
 * import { createServer } from "node:http";
 * import { toNodeHandler } from "@fragno-dev/node";
 * import { createExampleFragment } from "@rejot-dev/example-fragment";
 *
 * const library = createExampleFragment();
 *
 * const server = createServer(toNodeHandler(library.handler));
 * server.listen(8080);
 *
 * @example
 * import { createServer } from "node:http";
 * import { toNodeHandler } from "@fragno-dev/node";
 * import { createExampleFragment } from "@rejot-dev/example-fragment";
 *
 * const library = createExampleFragment();
 *
 * const server = createServer((req, res) => {
 *   if (req.url?.startsWith(library.mountRoute)) {
 *     const handler = toNodeHandler(library.handler);
 *     return handler(req, res);
 *   }
 *   // ... Your route handling
 * });
 * @example
 * import express from "express";
 * import { toNodeHandler } from "@fragno-dev/node";
 *
 * const app = express();
 * app.all("/api/my-library/{*any}", toNodeHandler(library.handler));
 *
 * app.listen(8080);
 */
export function toNodeHandler(handler: (req: Request) => Promise<Response>): RequestListener {
  return createRequestListener(handler);
}
