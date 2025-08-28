import type { RequestListener } from "node:http";
import { createRequestListener } from "@remix-run/node-fetch-server";

/**
 * Creates a handler that can be used with `node:http` to serve backend requests based on a Fragno
 * fragment (library).
 *
 * @example
 * import { createServer } from "node:http";
 * import { toNodeHandler } from "@fragno-dev/node";
 *
 * const server = createServer(toNodeHandler(library.handler));
 * server.listen(8080);
 *
 * @example
 * import { createServer } from "node:http";
 * import { toNodeHandler } from "@fragno-dev/node";
 *
 * const server = createServer((req, res) => {
 *   if (req.url?.startsWith(library.mountRoute)) {
 *     const handler = toNodeHandler(library.handler);
 *     return handler(req, res);
 *   }
 *   // ... Your route handling
 * });
 *
 */
export function toNodeHandler(handler: (req: Request) => Promise<Response>): RequestListener {
  return createRequestListener(handler);
}
