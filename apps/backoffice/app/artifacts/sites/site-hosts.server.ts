import {
  backofficeScopeJurisdiction,
  backofficeScopePathSegment,
  parseBackofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BlobsR2Access } from "@/fragno/blobs-r2-buckets";
import { generateRandomWords } from "@/fragno/inbound-email-address";

import { r2SiteObjects } from "./site-store.server";

/** Collisions are rare, so running out of draws means the generator or the registry is broken. */
const MAX_HOST_DRAWS = 5;

/** A subdomain a scope's sites are served at, such as `quiet-amber-falcon`. */
const SITE_HOST_LABEL = /^[a-z]+-[a-z]+-[a-z]+$/u;

/**
 * What this isolate read of claimed subdomains, by bucket and then subdomain or scope. A claim
 * never changes, so it is kept for good, and only a claim that exists is kept.
 */
const claimedScopes = new Map<string, BackofficeContextScope>();
const claimedHosts = new Map<string, string>();
const CLAIMS_KEPT = 10_000;

function keep<T>(claims: Map<string, T>, key: string, value: T): T {
  if (claims.size >= CLAIMS_KEPT) {
    claims.clear();
  }
  claims.set(key, value);
  return value;
}

/** Which scope each subdomain serves, and the subdomain of each scope with sites. */
export type SiteHosts = {
  /** The subdomain the scope's sites are served at, claimed the first time it is asked for. */
  hostFor(scope: BackofficeContextScope): Promise<string>;
  /** The scope a subdomain serves, or null when no scope claimed it. */
  scopeFor(host: string): Promise<BackofficeContextScope | null>;
};

/**
 * Subdomains kept in R2 beside the builds. `sites/hosts/<host>.json`, in the bucket of no
 * jurisdiction so that any request can read it, names the scope; `sites/<scope>/host.json`, in
 * the scope's own bucket, names its subdomain. Both are written only where absent, so two builds
 * never claim one subdomain, and a subdomain once claimed always serves the same scope.
 */
export function siteHosts(access: BlobsR2Access): SiteHosts {
  const hosts = r2SiteObjects(access, null, ["sites", "hosts"]);
  // Tests run several deployments in one isolate, each with buckets of its own.
  const bucket = `${access.buckets.none.endpoint}\n${access.buckets.none.bucket}\n`;
  const scopeObjects = (scope: BackofficeContextScope) =>
    r2SiteObjects(access, backofficeScopeJurisdiction(scope), [
      "sites",
      backofficeScopePathSegment(scope),
    ]);
  type Objects = typeof hosts;

  const read = async (objects: Objects, file: string): Promise<unknown> => {
    const response = await objects.request("GET", objects.objectUrl([file]), {}, null);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Could not read the site host ${file}: R2 answered ${response.status}.`);
    }
    return await response.json();
  };
  const create = async (objects: Objects, file: string, content: unknown) => {
    const response = await objects.request(
      "PUT",
      objects.objectUrl([file]),
      { "content-type": "application/json", "if-none-match": "*" },
      JSON.stringify(content),
    );
    if (response.status === 412) {
      return "taken" as const;
    }
    if (!response.ok) {
      throw new Error(`Could not claim the site host ${file}: R2 answered ${response.status}.`);
    }
    return "created" as const;
  };
  const claimedHost = async (objects: Objects) => {
    const file = await read(objects, "host.json");
    return file === null
      ? null
      : z.strictObject({ version: z.literal(1), host: z.string() }).parse(file).host;
  };

  return {
    async hostFor(scope) {
      const segment = backofficeScopePathSegment(scope);
      const key = `${bucket}${segment}`;
      const known = claimedHosts.get(key);
      if (known !== undefined) {
        return known;
      }
      const objects = scopeObjects(scope);
      const claimed = await claimedHost(objects);
      if (claimed !== null) {
        return keep(claimedHosts, key, claimed);
      }
      for (let draw = 0; draw < MAX_HOST_DRAWS; draw++) {
        const host = generateRandomWords();
        if ((await create(hosts, `${host}.json`, { version: 1, scope: segment })) === "taken") {
          continue;
        }
        if ((await create(objects, "host.json", { version: 1, host })) === "created") {
          return keep(claimedHosts, key, host);
        }
        // Another build claimed the scope a subdomain first; this one is given up.
        const released = await hosts.request("DELETE", hosts.objectUrl([`${host}.json`]), {}, null);
        if (!released.ok && released.status !== 404) {
          throw new Error(
            `Could not release the site host ${host}.json: R2 answered ${released.status}.`,
          );
        }
        const winner = await claimedHost(objects);
        if (winner !== null) {
          return keep(claimedHosts, key, winner);
        }
      }
      throw new Error(`No unclaimed site host after ${MAX_HOST_DRAWS} draws.`);
    },
    async scopeFor(host) {
      if (!SITE_HOST_LABEL.test(host)) {
        return null;
      }
      const key = `${bucket}${host}`;
      const known = claimedScopes.get(key);
      if (known !== undefined) {
        return known;
      }
      const file = await read(hosts, `${host}.json`);
      if (file === null) {
        return null;
      }
      const { scope } = z.strictObject({ version: z.literal(1), scope: z.string() }).parse(file);
      return keep(claimedScopes, key, parseBackofficeScopePathSegment(scope));
    },
  };
}

/**
 * The subdomains of the deployment's sites domain, or null where sites are served on Backoffice's
 * own origin.
 */
export function runtimeSiteHosts(
  runtime: Pick<BackofficeRuntimeServices, "config" | "siteStorage">,
): { hosts: SiteHosts; domain: string } | null {
  const domain = runtime.config.sitesDomain;
  if (domain === null) {
    return null;
  }
  if (!runtime.siteStorage) {
    throw new Error(
      "SITES_DOMAIN needs the blobs buckets (BLOBS_R2_*), which keep each scope's subdomain.",
    );
  }
  return { hosts: siteHosts(runtime.siteStorage), domain };
}
