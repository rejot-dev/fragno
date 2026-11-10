import { assert, test } from "vitest";

import { blobsR2BucketsFromEnv } from "@/fragno/blobs-r2-buckets";
import { createFakeR2 } from "@/fragno/blobs-r2.test-utils";

import { siteHosts } from "./site-hosts.server";

const buckets = blobsR2BucketsFromEnv(
  {
    BLOBS_R2_ENDPOINT: "https://account-1.r2.cloudflarestorage.com",
    BLOBS_R2_BUCKET: "backoffice-blobs",
    BLOBS_R2_ACCESS_KEY_ID: "access-key",
    BLOBS_R2_SECRET_ACCESS_KEY: "secret-key",
    DOCS_PUBLIC_BASE_URL: "https://backoffice.example/",
  },
  "enforced",
);
assert(buckets);

/**
 * Site hosts whose scope another build claims a subdomain for, `winner`, while this one claims
 * its own; R2 answers giving up this one's subdomain with `released`.
 */
function racingSiteHosts(orgId: string, released: "ok" | 500) {
  const r2 = createFakeR2(buckets!);
  const { fetch } = r2;
  const scopeClaim = `/sites/org%3A${orgId}/host.json`;
  const access = {
    buckets: buckets!,
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (request.method === "PUT" && pathname.endsWith(scopeClaim)) {
        await fetch(
          new Request(request.url, {
            method: "PUT",
            headers: request.headers,
            body: JSON.stringify({ version: 1, host: "winning-quiet-words" }),
          }),
        );
        return new Response("PreconditionFailed", { status: 412 });
      }
      if (request.method === "DELETE" && released === 500) {
        return new Response("InternalError", { status: 500 });
      }
      return await fetch(request);
    }) satisfies typeof globalThis.fetch,
  };
  const hostClaims = () =>
    [...r2.objects.keys()].filter((url) => url.includes("/sites/hosts/")).length;
  return { hosts: siteHosts(access), hostClaims };
}

test("a build that loses the race for its scope's subdomain gives its own up", async () => {
  const { hosts, hostClaims } = racingSiteHosts("race-won", "ok");
  assert.equal(
    await hosts.hostFor({ kind: "org", orgId: "race-won", jurisdiction: null }),
    "winning-quiet-words",
  );
  assert.equal(hostClaims(), 0);
});

test("a subdomain that cannot be given up fails the build, rather than staying claimed", async () => {
  const { hosts } = racingSiteHosts("race-stuck", 500);
  try {
    await hosts.hostFor({ kind: "org", orgId: "race-stuck", jurisdiction: null });
    assert.fail("Expected the build to fail.");
  } catch (error) {
    assert.match(String(error), /Could not release the site host [a-z-]+\.json: R2 answered 500/u);
  }
});
