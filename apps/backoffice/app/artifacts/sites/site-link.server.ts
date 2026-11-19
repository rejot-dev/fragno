import type {
  ArtifactSiteLink,
  ArtifactSiteLinkInput,
} from "@fragno-dev/backoffice-api/v0/artifacts";

import {
  deferBackofficeExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

import { SITE_LINK_PATH, siteHostOrigin } from "./site-host-names";
import { runtimeSiteHosts } from "./site-hosts.server";
import { sitePathProblem } from "./site-path";
import { SITE_LINK_LIFETIME_MS, signSiteLink } from "./site-session.server";

/**
 * A link that opens a site at its scope's address without signing in, for `execution` and the agent
 * acting for it, whom the host checks each time the link's visits ask.
 */
export async function createSiteLink({
  runtime,
  execution,
  input: { path, url, viewer },
}: {
  runtime: BackofficeRuntimeServices;
  execution: BackofficeExecutionContext;
  input: ArtifactSiteLinkInput;
}): Promise<ArtifactSiteLink> {
  const sites = runtimeSiteHosts(runtime);
  if (!runtime.config.sites || sites === null) {
    throw new Error("This deployment serves its sites at no address, so no link can open them.");
  }
  const problem = sitePathProblem(path);
  if (problem !== null) {
    throw new Error(problem);
  }
  const origin = siteHostOrigin(await sites.hosts.hostFor(execution.scope), sites.domain);
  const now = Date.now();
  const expiresAt = now + SITE_LINK_LIFETIME_MS;
  const link = crypto.randomUUID();
  const token = await signSiteLink(
    { secret: runtime.siteSecret(), origin, now },
    {
      id: link,
      sitePath: path,
      page: url ?? "/",
      viewer: viewer ?? null,
      execution: deferBackofficeExecution(execution),
    },
    expiresAt,
  );
  const opens = new URL(SITE_LINK_PATH, origin);
  opens.searchParams.set("token", token);
  return {
    url: opens.toString(),
    link,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}
