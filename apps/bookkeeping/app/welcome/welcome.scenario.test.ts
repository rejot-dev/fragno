import { expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
} from "../../scenario/bookkeeping-scenario";

test("a new person names themselves and their business, and lands in its workspace", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = scenario.browser();
    const welcome = await ada.signIn("ada@example.test");
    expect(welcome).toMatchObject({
      path: "/welcome",
      loaderData: { "welcome/welcome": { wizard: { step: "next-question" } } },
    });

    await scenario.drain();
    expect(await ada.navigate("/welcome")).toMatchObject({
      loaderData: { "welcome/welcome": { wizard: { step: "name" } } },
    });
    expect(await ada.submit("/welcome", { intent: "name", name: " " })).toMatchObject({
      actionData: { error: "Enter your name." },
    });
    // The page reloads before the workflow consumes an answer, and must not ask again.
    expect(await ada.submit("/welcome", { intent: "name", name: "Ada Lovelace" })).toMatchObject({
      loaderData: { "welcome/welcome": { wizard: { step: "next-question" } } },
    });
    await scenario.drain();
    expect(await ada.navigate("/welcome")).toMatchObject({
      loaderData: { "welcome/welcome": { wizard: { step: "business-name" } } },
    });

    const business = { intent: "business-name", businessName: "Analytical Engines" };
    expect(await ada.submit("/welcome", business)).toMatchObject({
      loaderData: { "welcome/welcome": { wizard: { step: "setting-up" } } },
    });
    await scenario.drain();
    // A second submission that arrives after the workspace exists, e.g. from another tab.
    expect(await ada.submit("/welcome", business)).toMatchObject({
      path: "/w/analytical-engines",
    });
    expect(await ada.navigate("/welcome")).toMatchObject({
      path: "/w/analytical-engines",
      loaderData: {
        "workspace/layout": {
          user: { name: "Ada Lovelace", email: "ada@example.test" },
          workspace: { slug: "analytical-engines", name: "Analytical Engines" },
          roles: ["owner"],
        },
      },
    });
    expect(scenario.backoffice.organization("analytical-engines").members).toEqual(
      new Map([["ada@example.test", ["owner"]]]),
    );

    // Signing in again goes straight to the workspace.
    expect(await scenario.browser().signIn("ada@example.test")).toMatchObject({
      path: "/w/analytical-engines",
    });
  });
});

test("someone Backoffice already knows by name is only asked about their business", async () => {
  await runBookkeepingScenario(async (scenario) => {
    scenario.backoffice.addUser({ email: "grace@example.test", name: "Grace Hopper" });
    const grace = scenario.browser();
    await grace.signIn("grace@example.test");
    await scenario.drain();
    expect(await grace.navigate("/welcome")).toMatchObject({
      loaderData: { "welcome/welcome": { wizard: { step: "business-name" } } },
    });
  });
});

/** Grace has answered her name, and her business's name is next. */
async function graceAtBusinessName(scenario: BookkeepingScenario) {
  const grace = scenario.browser();
  await grace.signIn("grace@example.test");
  await scenario.drain();
  await grace.submit("/welcome", { intent: "name", name: "Grace Hopper" });
  await scenario.drain();
  return grace;
}

test("setting up waits out a short Backoffice outage", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await graceAtBusinessName(scenario);
    scenario.backoffice.setReachable(false);
    await grace.submit("/welcome", { intent: "business-name", businessName: "Compilers" });
    await scenario.drain();
    expect(await grace.navigate("/welcome")).toMatchObject({
      loaderData: { "welcome/welcome": { wizard: { step: "setting-up" } } },
    });

    scenario.backoffice.setReachable(true);
    scenario.advanceTime(60_000);
    await scenario.drain();
    expect(await grace.navigate("/welcome")).toMatchObject({ path: "/w/compilers" });
  });
});

test("after a long Backoffice outage, setting up can be tried again", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await graceAtBusinessName(scenario);
    scenario.backoffice.setReachable(false);
    await grace.submit("/welcome", { intent: "business-name", businessName: "Compilers" });
    for (let attempt = 0; attempt < 8; attempt++) {
      await scenario.drain();
      scenario.advanceTime(60_000);
    }
    expect(await grace.navigate("/welcome")).toMatchObject({
      loaderData: { "welcome/welcome": { wizard: { step: "failed" } } },
    });

    scenario.backoffice.setReachable(true);
    await grace.submit("/welcome", { intent: "retry" });
    await scenario.drain();
    // Her answers were kept: the workspace has the name she gave.
    expect(await grace.navigate("/welcome")).toMatchObject({
      path: "/w/compilers",
      loaderData: { "workspace/layout": { workspace: { name: "Compilers" } } },
    });
  });
});
