import { expect, test } from "vitest";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";

test("an owner invites a colleague, who signs in with the invited address and joins", async () => {
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
    });
    const { link } = invited.actionData as { link: string };
    const invitationPath = new URL(link).pathname;

    const charles = scenario.browser();
    expect(await charles.navigate(invitationPath)).toMatchObject({
      loaderData: {
        "routes/invitation": {
          status: "open",
          workspaceName: "Analytical Engines",
          invitedBy: "Ada Lovelace",
          email: "charles@example.test",
          signedInAs: null,
        },
      },
    });
    expect(await charles.signIn("charles@example.test", invitationPath)).toMatchObject({
      path: invitationPath,
      loaderData: { "routes/invitation": { signedInAs: "charles@example.test" } },
    });
    expect(await charles.submit(invitationPath, {})).toMatchObject({
      path: "/w/analytical-engines",
      loaderData: { "routes/workspace-layout": { roles: ["member"] } },
    });
    expect(scenario.backoffice.organization("analytical-engines").members).toEqual(
      new Map([
        ["ada@example.test", ["owner"]],
        ["charles@example.test", ["member"]],
      ]),
    );

    // The link is used up, and Ada sees Charles among the members.
    expect(await charles.navigate(invitationPath)).toMatchObject({
      loaderData: { "routes/invitation": { status: "invalid" } },
    });
    expect(await ada.navigate("/w/analytical-engines/members")).toMatchObject({
      loaderData: {
        "routes/members": {
          members: [
            { name: "Ada Lovelace", email: "ada@example.test", roles: ["owner"] },
            { name: "", email: "charles@example.test", roles: ["member"] },
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

    const eve = scenario.browser();
    await eve.signIn("eve@example.test", invitationPath);
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

    const dora = scenario.browser();
    await dora.signIn("dora@example.test", invitationPath);
    await dora.submit(invitationPath, {});
    expect(await dora.navigate("/w/analytical-engines/members")).toMatchObject({
      loaderData: { "routes/members": { canInvite: false } },
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
