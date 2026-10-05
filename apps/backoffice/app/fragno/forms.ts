import { createFormsFragment, type FormsConfig } from "@fragno-dev/forms";

import {
  authorizeBackofficeFragmentRequest,
  type BackofficeFragmentHttpAccess,
} from "@/backoffice-runtime/fragment-http-authorization";
import type { BackofficeFragmentRuntimeOptions } from "@/backoffice-runtime/fragment-runtime";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

/** Creates the system-scoped Forms fragment server backed by its Durable Object database. */
export function createFormsServer(
  config: FormsConfig,
  runtime: BackofficeFragmentRuntimeOptions,
  kernel: BackofficeKernel,
): ReturnType<typeof createFormsFragment> {
  return createFormsFragment(config, {
    databaseAdapter: runtime.adapters.createAdapter({ kind: "forms" }),
    mountRoute: "/api/forms",
  }).withMiddleware(async function authorizeFormsRoutes({ ifMatchesRoute, requestContext }) {
    let access: BackofficeFragmentHttpAccess = null;
    await ifMatchesRoute("GET", "/:slug", () => {
      access = "public-ingress";
    });
    await ifMatchesRoute("POST", "/:slug/submit", () => {
      access = "public-ingress";
    });
    for (const path of [
      "/admin/forms",
      "/admin/forms/:id",
      "/admin/forms/:id/submissions",
      "/admin/submissions/:id",
    ] as const) {
      await ifMatchesRoute("GET", path, () => {
        access = BACKOFFICE_PERMISSION.forms.read;
      });
    }
    await ifMatchesRoute("POST", "/admin/forms", () => {
      access = BACKOFFICE_PERMISSION.forms.create;
    });
    await ifMatchesRoute("PUT", "/admin/forms/:id", () => {
      access = BACKOFFICE_PERMISSION.forms.update;
    });
    for (const path of ["/admin/forms/:id", "/admin/submissions/:id"] as const) {
      await ifMatchesRoute("DELETE", path, () => {
        access = BACKOFFICE_PERMISSION.forms.update;
      });
    }
    return await authorizeBackofficeFragmentRequest(kernel, requestContext, access, null);
  });
}

export type FormsFragment = ReturnType<typeof createFormsServer>;
