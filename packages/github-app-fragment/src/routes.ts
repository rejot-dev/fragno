import { defineRoutes } from "@fragno-dev/core";

import { githubAppFragmentDefinition } from "./github/definition";
import { githubAppInstallationRoutesFactory } from "./routes/installations";
import { githubAppOAuthRoutesFactory } from "./routes/oauth";
import { githubAppPullRoutesFactory } from "./routes/pulls";
import { githubAppRepositoryRoutesFactory } from "./routes/repositories";
import { githubAppWebhookRoutesFactory } from "./routes/webhooks";

export { githubAppOAuthRoutesFactory } from "./routes/oauth";
export { githubAppInstallationRoutesFactory } from "./routes/installations";
export { githubAppPullRoutesFactory } from "./routes/pulls";
export { githubAppRepositoryRoutesFactory } from "./routes/repositories";
export { githubAppWebhookRoutesFactory } from "./routes/webhooks";

export const githubAppRouteFactories = [
  githubAppWebhookRoutesFactory,
  githubAppOAuthRoutesFactory,
  githubAppInstallationRoutesFactory,
  githubAppRepositoryRoutesFactory,
  githubAppPullRoutesFactory,
] as const;

export const githubAppRoutesFactory = defineRoutes(githubAppFragmentDefinition).create(
  (context) => [
    ...githubAppWebhookRoutesFactory(context),
    ...githubAppOAuthRoutesFactory(context),
    ...githubAppInstallationRoutesFactory(context),
    ...githubAppRepositoryRoutesFactory(context),
    ...githubAppPullRoutesFactory(context),
  ],
);
