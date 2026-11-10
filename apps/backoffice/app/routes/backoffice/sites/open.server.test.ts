import { assert, expect, test } from "vitest";

import { organizationToSelect, siteSignInPage } from "./open.server";

test("the sign-in page posts its ticket to the site host, and runs only its own script", async () => {
  const response = await siteSignInPage({
    origin: "https://quiet-amber-falcon.ley.run",
    ticket: "payload.signature",
    next: '/shop.site/?q="><script>alert(1)</script>',
  });
  const html = await response.text();
  expect(html).toContain(
    '<form method="post" action="https://quiet-amber-falcon.ley.run/__ley/sign-in">',
  );
  expect(html).toContain(
    '<input type="hidden" name="next" value="/shop.site/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">',
  );
  const script = /<script>(.*)<\/script>/u.exec(html)?.[1] ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  assert.equal(
    response.headers.get("content-security-policy"),
    `default-src 'none'; script-src 'sha256-${hash}'; form-action https://quiet-amber-falcon.ley.run; base-uri 'none'; frame-ancestors 'none'`,
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("opening an organization's site selects that organization, when the viewer belongs to it", () => {
  const organizations = [
    { organization: { id: "org-a" } },
    { organization: { id: "org-b" } },
  ] as Parameters<typeof organizationToSelect>[1]["organizations"];
  const me = (activeOrganizationId: string | null) => ({ activeOrganizationId, organizations });
  assert.equal(
    organizationToSelect({ kind: "org", orgId: "org-b", jurisdiction: null }, me("org-a")),
    "org-b",
  );
  assert.equal(
    organizationToSelect({ kind: "org", orgId: "org-b", jurisdiction: null }, me(null)),
    "org-b",
  );
  assert.equal(
    organizationToSelect(
      {
        kind: "project",
        owner: { kind: "org", orgId: "org-b", jurisdiction: null },
        projectId: "p-1",
      },
      me("org-a"),
    ),
    "org-b",
  );
  // Already selected, not a member, or no organization's: the token is checked as it is.
  assert.isNull(
    organizationToSelect({ kind: "org", orgId: "org-a", jurisdiction: null }, me("org-a")),
  );
  assert.isNull(
    organizationToSelect({ kind: "org", orgId: "org-c", jurisdiction: null }, me("org-a")),
  );
  assert.isNull(
    organizationToSelect({ kind: "user", userId: "user-1", jurisdiction: null }, me("org-a")),
  );
});
