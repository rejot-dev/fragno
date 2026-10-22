import { createRequestHandler } from "react-router";
import * as serverBuild from "virtual:react-router/server-build";

import { BACKOFFICE_ACTIONS_PATH, handleBackofficeAction } from "./backoffice/actions";

export { Auth } from "./auth/auth";
export { Books } from "./books/books";
export { Directory } from "./directory/directory";

const handleRequest = createRequestHandler(serverBuild, import.meta.env.MODE);

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
      return env.AUTH.getByName("auth").fetch(request);
    }
    if (pathname === BACKOFFICE_ACTIONS_PATH) {
      return handleBackofficeAction(request, env);
    }
    return handleRequest(request);
  },
} satisfies ExportedHandler<CloudflareEnv>;
