import { expect, test } from "vitest";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";

test("signing in returns to the page that asked for it, and only to Bookkeeping's own pages", async () => {
  await runBookkeepingScenario(async (scenario) => {
    await scenario.signUp({
      email: "ada@example.test",
      name: "Ada Lovelace",
      businessName: "Analytical Engines",
    });

    const ada = scenario.browser();
    const login = await ada.navigate("/w/analytical-engines/members");
    expect(login).toMatchObject({
      path: "/login?returnTo=%2Fw%2Fanalytical-engines%2Fmembers",
      loaderData: {
        "public/login": { returnTo: "/w/analytical-engines/members", reauthorize: false },
      },
    });
    expect(await ada.signIn("ada@example.test", "/w/analytical-engines/members")).toMatchObject({
      path: "/w/analytical-engines/members",
      status: 200,
    });
    // Signed in, the login page sends her on.
    expect(await ada.navigate("/login?returnTo=%2Fw%2Fanalytical-engines")).toMatchObject({
      path: "/w/analytical-engines",
    });

    // The last two resolve on Bookkeeping's origin but normalize to `//evil.test`, another site.
    for (const elsewhere of [
      "//evil.test/x",
      "https://evil.test/",
      String.raw`/\evil.test`,
      "/.//evil.test/x",
      "/%2e//evil.test/x",
    ]) {
      expect(
        await scenario.browser().navigate(`/login?returnTo=${encodeURIComponent(elsewhere)}`),
      ).toMatchObject({ loaderData: { "public/login": { returnTo: "/start" } } });
    }
  });
});
