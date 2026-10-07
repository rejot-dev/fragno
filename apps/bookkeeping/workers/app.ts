import { createRequestHandler } from "react-router";
import * as serverBuild from "virtual:react-router/server-build";

export { Auth } from "./auth";

const handleRequest = createRequestHandler(serverBuild, import.meta.env.MODE);

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
      return env.AUTH.getByName("auth").fetch(request);
    }
    return handleRequest(request);
  },
} satisfies ExportedHandler<CloudflareEnv>;
