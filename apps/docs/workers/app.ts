import { createRequestHandler, RouterContextProvider } from "react-router";
import { CloudflareContext } from "../app/cloudflare/cloudflare-context";
import { MailingList } from "./mailing-list.do";
import { Forms } from "./forms.do";

// Export Durable Object classes
export { MailingList };
export { Forms };

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(CloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<CloudflareEnv>;
