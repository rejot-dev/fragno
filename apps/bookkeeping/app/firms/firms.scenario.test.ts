import { expect, test, assert } from "vitest";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";

test("an operator creates a firm for its owner, who accepts the emailed invitation and creates a client", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");

    // Ada has never signed in to Bookkeeping.
    const form = await grace.navigate("/operator/firms/new");
    const { externalId } = form.loaderData["operator/new-firm"] as { externalId: string };
    const created = await grace.submit("/operator/firms/new", {
      externalId,
      name: "Lovelace & Co",
      ownerEmail: "Ada@Example.test",
    });
    const link = `https://bookkeeping.test${scenario.invitationPath("ada@example.test")}`;
    expect(created).toMatchObject({
      actionData: {
        status: "created",
        name: "Lovelace & Co",
        path: "/f/lovelace-co",
        invitation: { email: "ada@example.test", link, emailed: true },
      },
    });
    // Backoffice made the operator its owner, so the operator could invite Ada as owner.
    expect(scenario.backoffice.organization("lovelace-co").members).toEqual(
      new Map([["grace@bookkeeping.test", ["owner"]]]),
    );
    expect(scenario.backoffice.pendingInvitations("lovelace-co")).toEqual([
      { email: "ada@example.test", roles: ["owner"], inviter: "grace@bookkeeping.test" },
    ]);

    const ada = scenario.browser();
    expect(await ada.navigate(new URL(link).pathname)).toMatchObject({
      status: 200,
      loaderData: {
        "invitations/invitation": {
          status: "open",
          invitedTo: "the accounting firm Lovelace & Co",
          invitedBy: "Grace Hopper",
          email: "ada@example.test",
          role: "owner",
        },
      },
    });
    const accepted = await scenario.acceptInvitation("ada@example.test", "Ada Lovelace", {
      browser: ada,
    });
    expect(accepted.page).toMatchObject({
      path: "/f/lovelace-co",
      loaderData: { "firms/dashboard": { firmName: "Lovelace & Co", clients: [] } },
    });
    expect(scenario.backoffice.organization("lovelace-co").members).toEqual(
      new Map([
        ["grace@bookkeeping.test", ["owner"]],
        ["ada@example.test", ["owner"]],
      ]),
    );
    // The operator stays an owner, to help.
    expect(await grace.navigate("/f/lovelace-co")).toMatchObject({ status: 200 });

    // Ada's only organization opens when she signs in.
    expect(await ada.navigate("/start")).toMatchObject({ path: "/f/lovelace-co" });

    // The client opens on its members page, to invite the client.
    const client = await scenario.createClient(ada, "/f/lovelace-co", "Analytical Engines");
    expect(client).toMatchObject({
      path: "/w/analytical-engines/members",
      status: 200,
      loaderData: {
        "clients/layout": {
          place: { mode: "client", name: "Analytical Engines", path: "/w/analytical-engines" },
          user: { name: "Ada Lovelace", role: "Owner" },
        },
      },
    });
    expect(scenario.backoffice.organization("analytical-engines").members).toEqual(
      new Map([["ada@example.test", ["owner"]]]),
    );
    expect(await ada.navigate("/f/lovelace-co")).toMatchObject({
      loaderData: {
        "firms/dashboard": {
          clients: [{ name: "Analytical Engines", path: "/w/analytical-engines", member: true }],
        },
      },
    });
    // With two organizations, signing in offers a choice, and so does the switcher.
    const places = [
      { mode: "firm", name: "Lovelace & Co", path: "/f/lovelace-co" },
      { mode: "client", name: "Analytical Engines", path: "/w/analytical-engines" },
    ];
    expect(await ada.navigate("/start")).toMatchObject({
      path: "/start",
      loaderData: { "organizations/start": { places } },
    });
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: { "clients/layout": { places } },
    });
  });
});

test("only operators reach the operator's pages and create firms", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = await scenario.signUp("ada@example.test", "Ada Lovelace");
    expect(await ada.navigate("/operator")).toMatchObject({ status: 404 });
    expect(await ada.navigate("/operator/firms/new")).toMatchObject({ status: 404 });
    expect(
      await ada.submit("/operator/firms/new", {
        externalId: crypto.randomUUID(),
        name: "Lovelace & Co",
        ownerEmail: "ada@example.test",
      }),
    ).toMatchObject({ status: 404 });
    assert(scenario.backoffice.organizationCount() === 0);
  });
});

test("an operator lands on the firms, which lists every firm and opens their own", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    const alan = await scenario.signUp("alan@bookkeeping.test", "Alan Turing");
    scenario.setOperators("grace@bookkeeping.test", "alan@bookkeeping.test");
    // With nowhere else to go, signing in opens the firms.
    expect(await grace.navigate("/start")).toMatchObject({
      path: "/operator",
      loaderData: {
        "operator/layout": {
          place: { mode: "operator", name: "Bookkeeping", path: "/operator" },
          places: [{ mode: "operator", path: "/operator" }],
          user: { name: "Grace Hopper", role: "Operator" },
        },
        "operator/firms": { firms: [] },
      },
    });

    await scenario.createFirm(grace, "Lovelace & Co", "ada@example.test");
    await scenario.createFirm(alan, "Enigma Accounting", "joan@example.test");
    expect(await grace.navigate("/operator")).toMatchObject({
      loaderData: {
        "operator/layout": {
          places: [
            { mode: "operator", path: "/operator" },
            { mode: "firm", name: "Lovelace & Co", path: "/f/lovelace-co" },
          ],
        },
        "operator/firms": {
          firms: [
            { name: "Enigma Accounting", path: "/f/enigma-accounting", member: false },
            { name: "Lovelace & Co", path: "/f/lovelace-co", member: true },
          ],
        },
      },
    });
    expect(await grace.navigate("/f/enigma-accounting")).toMatchObject({ status: 404 });
    // The operator's page and a firm make two places, so signing in offers the choice.
    expect(await grace.navigate("/start")).toMatchObject({ path: "/start" });
  });
});

test("trying again after a failure creates one client", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");
    const firmPath = await scenario.createFirm(grace, "Lovelace & Co", "ada@example.test");
    const { browser: ada } = await scenario.acceptInvitation("ada@example.test", "Ada Lovelace");
    const path = `${firmPath}/clients/new`;
    const form = await ada.navigate(path);
    const { externalId } = form.loaderData["firms/new-client"] as { externalId: string };
    const failed = { externalId, error: "Creating the client didn't work. Try again shortly." };

    scenario.backoffice.setReachable(false);
    expect(await ada.submit(path, { externalId, name: "Analytical Engines" })).toMatchObject({
      actionData: failed,
    });
    scenario.backoffice.setReachable(true);
    // Backoffice creates it, but Bookkeeping never hears so.
    scenario.backoffice.failNextResponse("organizations.provision");
    expect(await ada.submit(path, { externalId, name: "Analytical Engines" })).toMatchObject({
      actionData: failed,
    });

    expect(await ada.submit(path, { externalId, name: "Analytical Engines" })).toMatchObject({
      path: "/w/analytical-engines/members",
      status: 200,
    });
    assert(scenario.backoffice.organizationCount() === 2);
    expect(await ada.navigate(firmPath)).toMatchObject({
      loaderData: { "firms/dashboard": { clients: [{ name: "Analytical Engines" }] } },
    });
  });
});

test("trying again after inviting failed creates one firm and one invitation", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");
    const form = await grace.navigate("/operator/firms/new");
    const { externalId } = form.loaderData["operator/new-firm"] as { externalId: string };
    const submission = { externalId, name: "Lovelace & Co", ownerEmail: "ada@example.test" };

    // Backoffice creates the invitation, but Bookkeeping never hears so.
    scenario.backoffice.failNextResponse("invitations.create");
    expect(await grace.submit("/operator/firms/new", submission)).toMatchObject({
      actionData: {
        status: "failed",
        externalId,
        error: "Lovelace & Co was created, but its owner was not invited yet. Try again shortly.",
      },
    });
    expect(await grace.submit("/operator/firms/new", submission)).toMatchObject({
      actionData: { status: "created", path: "/f/lovelace-co", invitation: { emailed: true } },
    });
    assert(scenario.backoffice.organizationCount() === 1);
    expect(scenario.backoffice.pendingInvitations("lovelace-co")).toHaveLength(1);
    expect(scenario.backoffice.sentInvitations).toHaveLength(1);
    const { page } = await scenario.acceptInvitation("ada@example.test", "Ada Lovelace");
    expect(page).toMatchObject({ path: "/f/lovelace-co" });
  });
});

test("when Backoffice cannot email, the operator shares the invitation link", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");
    scenario.backoffice.setEmailConfigured(false);
    const form = await grace.navigate("/operator/firms/new");
    const { externalId } = form.loaderData["operator/new-firm"] as { externalId: string };
    const created = await grace.submit("/operator/firms/new", {
      externalId,
      name: "Lovelace & Co",
      ownerEmail: "ada@example.test",
    });
    expect(created).toMatchObject({ actionData: { invitation: { emailed: false } } });
    expect(scenario.backoffice.sentInvitations).toEqual([]);
    const { link } = (created.actionData as { invitation: { link: string } }).invitation;
    const accepted = await scenario.acceptInvitation("ada@example.test", "Ada Lovelace", {
      path: new URL(link).pathname,
    });
    expect(accepted.page).toMatchObject({ path: "/f/lovelace-co", status: 200 });
  });
});

test("an operator who names themselves owns the firm without an invitation", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");
    const form = await grace.navigate("/operator/firms/new");
    const { externalId } = form.loaderData["operator/new-firm"] as { externalId: string };
    expect(
      await grace.submit("/operator/firms/new", {
        externalId,
        name: "Hopper Books",
        ownerEmail: "grace@bookkeeping.test",
      }),
    ).toMatchObject({
      actionData: { status: "created", path: "/f/hopper-books", invitation: null },
    });
    expect(scenario.backoffice.pendingInvitations("hopper-books")).toEqual([]);
    expect(await grace.navigate("/f/hopper-books")).toMatchObject({ status: 200 });
  });
});

test("a firm's members open its clients only as their members", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { firmPath, clientPath } = await scenario.practice();
    const joan = await scenario.signUp("joan@example.test", "Joan Clarke");
    // Added to the firm in Backoffice itself, so Bookkeeping learns of it when she opens the firm.
    scenario.backoffice.admin.addMember("lovelace-co", "joan@example.test", ["member"]);
    expect(await joan.navigate(firmPath)).toMatchObject({
      status: 200,
      loaderData: {
        "firms/dashboard": { clients: [{ name: "Analytical Engines", member: false }] },
      },
    });
    expect(await joan.navigate(clientPath)).toMatchObject({ status: 404 });
    // Nor does a client open as a firm, or the other way around.
    expect(await joan.navigate("/w/lovelace-co")).toMatchObject({ status: 404 });
    expect(await joan.navigate("/f/analytical-engines")).toMatchObject({ status: 404 });
  });
});
