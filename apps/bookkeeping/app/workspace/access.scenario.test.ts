import { expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
} from "../../scenario/bookkeeping-scenario";

const CONFIRMATION_EXPIRED_MS = 61_000;

/** Ada's workspace, with Charles joined as a member through an invitation. */
async function workspaceWithColleague(scenario: BookkeepingScenario) {
  const ada = await scenario.signUp({
    email: "ada@example.test",
    name: "Ada Lovelace",
    businessName: "Analytical Engines",
  });
  const invited = await ada.submit("/w/analytical-engines/members", {
    email: "charles@example.test",
    role: "member",
  });
  const invitationPath = new URL((invited.actionData as { link: string }).link).pathname;
  const charles = scenario.browser();
  await charles.signIn("charles@example.test", invitationPath);
  await charles.submit(invitationPath, {});
  return { ada, charles };
}

test("Backoffice's membership and roles reach Bookkeeping within a minute", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, charles } = await workspaceWithColleague(scenario);

    scenario.backoffice.admin.setRoles("analytical-engines", "charles@example.test", ["admin"]);
    scenario.backoffice.admin.rename("analytical-engines", "Difference Engines");
    // A confirmed membership is trusted for a minute.
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: { "workspace/layout": { roles: ["member"] } },
    });
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: {
        "workspace/layout": {
          roles: ["admin"],
          workspace: { name: "Difference Engines" },
        },
      },
    });

    scenario.backoffice.admin.removeMember("analytical-engines", "charles@example.test");
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({ status: 404 });
    // Without a workspace, Charles is offered to set up his own.
    expect(await charles.navigate("/start")).toMatchObject({ path: "/welcome" });
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({ status: 200 });
  });
});

test("uninstalling Bookkeeping hides the workspace, and an outage keeps no one in", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await workspaceWithColleague(scenario);

    scenario.backoffice.setReachable(false);
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({ status: 200 });
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({
      status: 503,
      error: "Backoffice could not be reached. Try again shortly.",
    });
    scenario.backoffice.setReachable(true);

    scenario.backoffice.admin.uninstall("analytical-engines");
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({ status: 404 });
    expect(await ada.navigate("/start")).toMatchObject({ path: "/welcome" });
  });
});
