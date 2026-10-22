import { expect, test, assert } from "vitest";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";

const INVITATION_EXPIRED_MS = 49 * 60 * 60 * 1000;

test("a client's owner invites the client, who follows the emailed link, signs in with the invited address, and joins", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();
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
    expect(scenario.backoffice.sentInvitations).toContainEqual({
      to: "charles@example.test",
      url: link,
    });
    const invitationPath = new URL(link).pathname;

    const charles = scenario.browser();
    expect(await charles.navigate(invitationPath)).toMatchObject({
      loaderData: {
        "invitations/invitation": {
          status: "open",
          invitedTo: "the books of Analytical Engines",
          invitedBy: "Ada Lovelace",
          email: "charles@example.test",
          role: "member",
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
      loaderData: { "clients/layout": { user: { role: "Member" } } },
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
        "clients/members": {
          team: {
            members: [
              { name: "Ada Lovelace", email: "ada@example.test", role: "owner", you: true },
              { name: "Charles Babbage", email: "charles@example.test", role: "member" },
            ],
            invitations: [],
          },
        },
      },
    });
  });
});

test("an invitation works only for its address, and only owners and admins invite", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();
    const path = await scenario.invite(ada, "/w/analytical-engines", "dora@example.test", "member");
    // Pending, with the link for Ada to share.
    expect(await ada.navigate("/w/analytical-engines/members")).toMatchObject({
      loaderData: {
        "clients/members": {
          team: {
            invitations: [
              {
                email: "dora@example.test",
                role: "member",
                invitedBy: "Ada Lovelace",
                link: `https://bookkeeping.test${path}`,
              },
            ],
          },
        },
      },
    });

    scenario.backoffice.addUser({ email: "eve@example.test", name: "Eve" });
    const eve = scenario.browser();
    expect(await eve.signIn("eve@example.test", path)).toMatchObject({
      loaderData: {
        "invitations/invitation": { email: "dora@example.test", signedInAs: "eve@example.test" },
      },
    });
    // Backoffice refuses even when the page's own check is bypassed.
    expect(await eve.submit(path, {})).toMatchObject({
      path,
      actionData: {
        error:
          "This invitation is for dora@example.test, but you're signed in as eve@example.test.",
      },
    });
    assert(!scenario.backoffice.organization("analytical-engines").members.has("eve@example.test"));

    const { browser: dora } = await scenario.acceptInvitation("dora@example.test", "Dora", {
      path,
    });
    expect(await dora.navigate("/w/analytical-engines/members")).toMatchObject({
      loaderData: { "clients/members": { team: { inviteRoles: [] } } },
    });
    expect(
      await dora.submit("/w/analytical-engines/members", {
        email: "frank@example.test",
        role: "member",
      }),
    ).toMatchObject({
      actionData: { status: "failed", error: "Only owners and admins invite." },
    });
  });
});

test("when Backoffice cannot email, the owner sends the invitation link themselves", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();
    scenario.backoffice.setEmailConfigured(false);
    const sent = scenario.backoffice.sentInvitations.length;
    const invited = await ada.submit("/w/analytical-engines/members", {
      email: "charles@example.test",
      role: "member",
    });
    expect(invited.actionData).toMatchObject({ status: "invited", emailed: false });
    expect(scenario.backoffice.sentInvitations).toHaveLength(sent);

    const { page } = await scenario.acceptInvitation("charles@example.test", "Charles Babbage", {
      path: new URL((invited.actionData as { link: string }).link).pathname,
    });
    expect(page).toMatchObject({ path: "/w/analytical-engines", status: 200 });
  });
});

test("an expired invitation is no longer valid", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();
    const path = await scenario.invite(
      ada,
      "/w/analytical-engines",
      "charles@example.test",
      "member",
    );
    const charles = await scenario.signUp("charles@example.test", "Charles Babbage");
    scenario.advanceTime(INVITATION_EXPIRED_MS);
    expect(await charles.navigate(path)).toMatchObject({
      loaderData: { "invitations/invitation": { status: "invalid" } },
    });
    expect(await charles.submit(path, {})).toMatchObject({
      actionData: { error: "This invitation is no longer valid." },
    });
    assert(
      !scenario.backoffice.organization("analytical-engines").members.has("charles@example.test"),
    );
  });
});

test("an unknown outcome keeps the invitation for another try", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();
    const path = await scenario.invite(
      ada,
      "/w/analytical-engines",
      "charles@example.test",
      "member",
    );
    const charles = await scenario.signUp("charles@example.test", "Charles Babbage");

    scenario.backoffice.setReachable(false);
    expect(await charles.submit(path, {})).toMatchObject({
      actionData: { error: "Accepting didn't work. Try again shortly." },
    });
    scenario.backoffice.setReachable(true);
    // Backoffice accepts it, but Bookkeeping never hears so; accepting again returns the membership.
    scenario.backoffice.failNextResponse("invitations.accept");
    expect(await charles.submit(path, {})).toMatchObject({
      actionData: { error: "Accepting didn't work. Try again shortly." },
    });
    expect(await charles.submit(path, {})).toMatchObject({
      path: "/w/analytical-engines",
      status: 200,
    });
  });
});
