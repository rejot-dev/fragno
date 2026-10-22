import { expect, test } from "vitest";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";

test("an owner invites a colleague, who follows the emailed link, signs in with the invited address, and joins", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = await scenario.signUp({
      email: "ada@example.test",
      name: "Ada Lovelace",
      businessName: "Analytical Engines",
    });
    const invited = await ada.submit("/w/analytical-engines/members", {
      email: "Charles@Example.test",
      role: "member",
    });
    expect(invited.actionData).toMatchObject({
      status: "invited",
      email: "charles@example.test",
      link: expect.stringMatching(/^https:\/\/bookkeeping\.test\/invitations\/.+$/u),
      emailed: true,
    });
    // Backoffice emailed Charles the link in Bookkeeping's name.
    const { link } = invited.actionData as { link: string };
    expect(scenario.backoffice.sentInvitations).toEqual([
      { to: "charles@example.test", url: link },
    ]);
    const invitationPath = new URL(link).pathname;

    const charles = scenario.browser();
    expect(await charles.navigate(invitationPath)).toMatchObject({
      loaderData: {
        "invitations/invitation": {
          status: "open",
          workspaceName: "Analytical Engines",
          invitedBy: "Ada Lovelace",
          email: "charles@example.test",
          signedInAs: null,
        },
      },
    });
    // He gives his name before he joins, then comes back to the invitation.
    const named = await charles.signIn("charles@example.test", invitationPath);
    expect(named).toMatchObject({
      path: `/name?returnTo=${encodeURIComponent(invitationPath)}`,
    });
    expect(await charles.submit(named.path, { name: "Charles Babbage" })).toMatchObject({
      path: invitationPath,
      loaderData: { "invitations/invitation": { signedInAs: "charles@example.test" } },
    });
    expect(await charles.submit(invitationPath, {})).toMatchObject({
      path: "/w/analytical-engines",
      loaderData: { "workspace/layout": { roles: ["member"] } },
    });
    expect(scenario.backoffice.organization("analytical-engines").members).toEqual(
      new Map([
        ["ada@example.test", ["owner"]],
        ["charles@example.test", ["member"]],
      ]),
    );

    // The link is used up, and Ada sees Charles among the members.
    expect(await charles.navigate(invitationPath)).toMatchObject({
      loaderData: { "invitations/invitation": { status: "invalid" } },
    });
    expect(await ada.navigate("/w/analytical-engines/members")).toMatchObject({
      loaderData: {
        "workspace/members": {
          members: [
            { name: "Ada Lovelace", email: "ada@example.test", roles: ["owner"] },
            { name: "Charles Babbage", email: "charles@example.test", roles: ["member"] },
          ],
          invitations: [],
        },
      },
    });
  });
});

test("an invitation works only for its address, and only owners and admins invite", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = await scenario.signUp({
      email: "ada@example.test",
      name: "Ada Lovelace",
      businessName: "Analytical Engines",
    });
    const forDora = await ada.submit("/w/analytical-engines/members", {
      email: "dora@example.test",
      role: "member",
    });
    const invitationPath = new URL((forDora.actionData as { link: string }).link).pathname;

    scenario.backoffice.addUser({ email: "eve@example.test", name: "Eve" });
    const eve = scenario.browser();
    expect(await eve.signIn("eve@example.test", invitationPath)).toMatchObject({
      loaderData: {
        "invitations/invitation": { email: "dora@example.test", signedInAs: "eve@example.test" },
      },
    });
    expect(await eve.submit(invitationPath, {})).toMatchObject({
      path: invitationPath,
      actionData: {
        error:
          "This invitation is for dora@example.test, but you're signed in as eve@example.test.",
      },
    });
    expect([...scenario.backoffice.organization("analytical-engines").members.keys()]).toEqual([
      "ada@example.test",
    ]);

    scenario.backoffice.addUser({ email: "dora@example.test", name: "Dora" });
    const dora = scenario.browser();
    await dora.signIn("dora@example.test", invitationPath);
    await dora.submit(invitationPath, {});
    expect(await dora.navigate("/w/analytical-engines/members")).toMatchObject({
      loaderData: { "workspace/members": { canInvite: false } },
    });
    expect(
      await dora.submit("/w/analytical-engines/members", {
        email: "frank@example.test",
        role: "member",
      }),
    ).toMatchObject({
      actionData: { status: "rejected", message: "Only owners and admins invite." },
    });
  });
});

test("when Backoffice cannot email, the owner sends the invitation link themselves", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = await scenario.signUp({
      email: "ada@example.test",
      name: "Ada Lovelace",
      businessName: "Analytical Engines",
    });
    scenario.backoffice.setEmailConfigured(false);
    const invited = await ada.submit("/w/analytical-engines/members", {
      email: "charles@example.test",
      role: "member",
    });
    expect(invited.actionData).toMatchObject({ status: "invited", emailed: false });
    expect(scenario.backoffice.sentInvitations).toEqual([]);

    scenario.backoffice.addUser({ email: "charles@example.test", name: "Charles Babbage" });
    const charles = scenario.browser();
    const invitationPath = new URL((invited.actionData as { link: string }).link).pathname;
    await charles.signIn("charles@example.test", invitationPath);
    expect(await charles.submit(invitationPath, {})).toMatchObject({
      path: "/w/analytical-engines",
    });
  });
});
