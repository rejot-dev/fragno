import { handleReactRouterRequest } from "./react-router-handler";

export default {
  fetch: handleReactRouterRequest,
} satisfies ExportedHandler<CloudflareEnv>;
