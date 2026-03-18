import { isBackofficeRequest } from "./route-target";

type RouterEnv = {
  BACKOFFICE_APP: Fetcher;
  DOCS_APP: Fetcher;
};

export default {
  async fetch(request, env) {
    const service = isBackofficeRequest(request) ? env.BACKOFFICE_APP : env.DOCS_APP;
    return service.fetch(request);
  },
} satisfies ExportedHandler<RouterEnv>;
