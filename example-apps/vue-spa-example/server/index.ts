import { toNodeHandler } from "@fragno-dev/node";
import { createExampleFragment } from "@fragno-dev/example-fragment";
import { createServer, type Server } from "node:http";

const fragment = createExampleFragment();
const server = createServer(toNodeHandler(fragment.handler));
server.listen(8080, undefined, () => {
  const host = addressToString(server);
  console.log("Server is running on:", `${host}${fragment.mountRoute}`);

  console.log("GET Routes:");
  fragment.routes.forEach((route) => {
    if (route.method !== "GET") {
      return;
    }

    console.log(`  ${host}${fragment.mountRoute}${route.path}`);
  });
});

function addressToString(server: Server, protocol: "http" | "https" = "http"): string {
  const addr = server.address();
  if (!addr) {
    throw new Error("Address invalid");
  }

  if (typeof addr === "string") {
    // For UNIX domain sockets or named pipes
    return addr;
  }

  let host = addr.address;

  // When listening on all interfaces, map to localhost for clickable link
  if (host === "::" || host === "0.0.0.0") {
    host = "localhost";
  }

  // IPv6 needs brackets in URLs
  if (addr.family === "IPv6" && host !== "localhost") {
    host = `[${host}]`;
  }

  return `${protocol}://${host}:${addr.port}`;
}
