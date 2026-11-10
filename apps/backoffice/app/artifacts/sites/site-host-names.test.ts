import { assert, test } from "vitest";

import { parseSitesDomain } from "@/backoffice-runtime/runtime-services";

import { siteHostDestination, siteHostOf, siteHostOrigin, siteUrl } from "./site-host-names";

test("a request names a site host only under the sites domain", () => {
  assert.equal(
    siteHostOf(new URL("https://quiet-amber-falcon.ley.run/a.site/"), "ley.run"),
    "quiet-amber-falcon",
  );
  assert.isNull(siteHostOf(new URL("https://ley.run/"), "ley.run"));
  assert.isUndefined(siteHostOf(new URL("https://leyway.com/backoffice"), "ley.run"));
  assert.isUndefined(siteHostOf(new URL("https://notley.run/"), "ley.run"));
  assert.equal(
    siteHostOf(new URL("http://quiet-amber-falcon.localhost:5467/"), "localhost:5467"),
    "quiet-amber-falcon",
  );
});

test("sites are served over https, and over http only on localhost", () => {
  assert.equal(
    siteHostOrigin("quiet-amber-falcon", "ley.run"),
    "https://quiet-amber-falcon.ley.run",
  );
  assert.equal(
    siteHostOrigin("quiet-amber-falcon", "localhost:5467"),
    "http://quiet-amber-falcon.localhost:5467",
  );
  assert.equal(
    siteUrl("https://quiet-amber-falcon.ley.run", "/workspace/my tools/shop.site"),
    "https://quiet-amber-falcon.ley.run/my%20tools/shop.site/",
  );
});

test("a sites domain is spelled without its scheme's default port, as URLs spell hosts", () => {
  for (const [configured, domain] of [
    ["ley.run:443", "ley.run"],
    ["localhost:80", "localhost"],
    ["Ley.Run", "ley.run"],
    ["ley.run:8443", "ley.run:8443"],
    ["localhost:443", "localhost:443"],
  ]) {
    assert.equal(parseSitesDomain(configured), domain);
    const origin = siteHostOrigin("quiet-amber-falcon", domain);
    assert.equal(siteHostOf(new URL(`${origin}/a.site/`), domain), "quiet-amber-falcon");
  }
});

test("signing in continues only at the site host, wherever browsers would take `next`", () => {
  const origin = "https://quiet-amber-falcon.ley.run";
  for (const [next, destination] of [
    ["/shop.site/?tab=all#top", `${origin}/shop.site/?tab=all#top`],
    [`${origin}/shop.site/`, `${origin}/shop.site/`],
    // Resolves to `//evil.example/` within the host, which stays absolute.
    ["/x/..//evil.example/", `${origin}//evil.example/`],
  ]) {
    assert.equal(siteHostDestination(origin, next), destination);
  }
  for (const next of [
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "/\n/evil.example/",
    "https://evil.example/",
    "https://quiet-amber-falcon.ley.run.evil.example/",
    "http://quiet-amber-falcon.ley.run/",
    "javascript:alert(1)",
  ]) {
    assert.isNull(siteHostDestination(origin, next), next);
  }
});
