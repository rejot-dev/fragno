import { expect, test, assert } from "vitest";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";

const CONFIRMATION_EXPIRED_MS = 61_000;

test("an operator invites another, who becomes an operator by accepting", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");
    expect(await grace.navigate("/operator/members")).toMatchObject({
      loaderData: {
        "operator/members": {
          team: {
            members: [{ name: "Grace Hopper", role: "owner", you: true }],
            inviteRoles: ["member", "admin", "owner"],
          },
        },
      },
    });

    const path = await scenario.invite(grace, "/operator", "alan@bookkeeping.test", "admin");
    const alan = scenario.browser();
    expect(await alan.navigate(path)).toMatchObject({
      loaderData: {
        "invitations/invitation": {
          invitedTo: "Bookkeeping operators, the team that runs Bookkeeping",
          invitedBy: "Grace Hopper",
          role: "admin",
        },
      },
    });
    const accepted = await scenario.acceptInvitation("alan@bookkeeping.test", "Alan Turing", {
      browser: alan,
      path,
    });
    expect(accepted.page).toMatchObject({
      path: "/operator",
      loaderData: { "operator/layout": { user: { name: "Alan Turing", role: "Admin" } } },
    });
    // He creates firms as any operator does.
    assert(
      (await scenario.createFirm(alan, "Enigma Accounting", "joan@example.test")) ===
        "/f/enigma-accounting",
    );
  });
});

test("an operator removed in Backoffice loses the operator's pages within a minute", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    const alan = await scenario.signUp("alan@bookkeeping.test", "Alan Turing");
    scenario.setOperators("grace@bookkeeping.test", "alan@bookkeeping.test");
    expect(await alan.navigate("/operator")).toMatchObject({ status: 200 });

    scenario.backoffice.admin.removeMember("bookkeeping-operators", "alan@bookkeeping.test");
    // A confirmed membership is trusted for a minute.
    expect(await alan.navigate("/operator")).toMatchObject({ status: 200 });
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await alan.navigate("/operator/firms/new")).toMatchObject({ status: 404 });
    expect(await alan.navigate("/start")).toMatchObject({
      loaderData: { "organizations/start": { places: [] } },
    });
    expect(await grace.navigate("/operator")).toMatchObject({ status: 200 });
  });
});
