import { ARTIFACT_SITE_DATA_PERMISSIONS } from "@fragno-dev/backoffice-api/v0/artifacts";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  BackofficeForbiddenError,
  type BackofficeForbiddenErrorDetails,
  type BackofficeKernel,
} from "@/backoffice-runtime/kernel";

import { mayFireSiteEvents } from "./site-events.server";

/**
 * What whoever builds a site may let its `worker.js` do. The tool's caller decides it, as its
 * kernel holds the builder's grants: an agent's turn narrows them only in the runtime it runs in,
 * not in the scope's Codemode object that builds.
 */
export type SiteBuilderAuthority = {
  /** Why the builder may not read what a `worker.js` reads, or null when they may. */
  dataDenial: BackofficeForbiddenErrorDetails | null;
  /** Whether the builder may emit the events a `worker.js` fires. */
  fires: boolean;
};

/** Checks what the builder may let a site's `worker.js` do; an authority outage throws. */
export async function siteBuilderAuthority({
  kernel,
  execution,
  sitePath,
}: {
  kernel: Pick<BackofficeKernel, "assertAuthorizedAll">;
  execution: BackofficeExecutionContext;
  sitePath: string;
}): Promise<SiteBuilderAuthority> {
  const [dataDenial, fires] = await Promise.all([
    kernel
      .assertAuthorizedAll({
        execution,
        requirements: ARTIFACT_SITE_DATA_PERMISSIONS.map((operation) => ({
          operation,
          resource: { path: sitePath },
        })),
      })
      .then(
        () => null,
        (error: unknown) => {
          if (
            error instanceof BackofficeForbiddenError &&
            error.reason !== "authority-unavailable"
          ) {
            return { message: error.message, reason: error.reason };
          }
          throw error;
        },
      ),
    mayFireSiteEvents({ kernel, execution, sitePath }),
  ]);
  return { dataDenial, fires };
}
