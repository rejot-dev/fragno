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
        owner: { status: "invited", email: "ada@example.test", link, emailed: true },
      },
    });
    // Until Ada accepts, the firm has no members: the operator only invited her.
    expect(scenario.backoffice.organization("lovelace-co").members).toEqual(new Map());
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
      new Map([["ada@example.test", ["owner"]]]),
    );
    // The firm is Ada's: the operator does not open it.
    expect(await grace.navigate("/f/lovelace-co")).toMatchObject({ status: 404 });

    // Ada's only organization opens when she signs in.
    expect(await ada.navigate("/start")).toMatchObject({ path: "/f/lovelace-co" });

    // The client opens on its members page, to invite the client. The firm manages it, so Ada
    // acts in it as the firm's owner, as an admin, without becoming its member.
    const client = await scenario.createClient(ada, "/f/lovelace-co", "Analytical Engines");
    expect(client).toMatchObject({
      path: "/w/analytical-engines/members",
      status: 200,
      loaderData: {
        "clients/layout": {
          place: { mode: "client", name: "Analytical Engines", path: "/w/analytical-engines" },
          user: { name: "Ada Lovelace", role: "Admin" },
        },
      },
    });
    expect(scenario.backoffice.organization("analytical-engines").members).toEqual(new Map());
    expect(await ada.navigate("/f/lovelace-co")).toMatchObject({
      loaderData: {
        "firms/dashboard": {
          clients: [{ name: "Analytical Engines", path: "/w/analytical-engines", member: true }],
          canCreate: true,
        },
      },
    });
    // The firm's clients are reached through the firm, so Ada's own places stay the firm.
    const places = [{ mode: "firm", name: "Lovelace & Co", path: "/f/lovelace-co" }];
    expect(await ada.navigate("/start")).toMatchObject({ path: "/f/lovelace-co" });
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

test("an operator lands on the firms, which lists every firm, opening none they were not invited to", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    const alan = await scenario.signUp("alan@bookkeeping.test", "Alan Turing");
    scenario.setOperators("grace@bookkeeping.test", "alan@bookkeeping.test");
    // Backoffice's administrator made her an operator, so Bookkeeping learns so when she opens
    // the operator's pages, as `backoffice:connect` tells her to.
    expect(await grace.navigate("/operator")).toMatchObject({
      path: "/operator",
      loaderData: {
        "operator/layout": {
          place: { mode: "operator", name: "Bookkeeping operators", path: "/operator" },
          places: [{ mode: "operator", path: "/operator" }],
          user: { name: "Grace Hopper", role: "Owner" },
        },
        "operator/firms": { firms: [] },
      },
    });
    // With nowhere else to go, signing in opens the firms.
    expect(await grace.navigate("/start")).toMatchObject({ path: "/operator" });

    await scenario.createFirm(grace, "Lovelace & Co", "ada@example.test");
    await scenario.createFirm(alan, "Enigma Accounting", "joan@example.test");
    expect(await grace.navigate("/operator")).toMatchObject({
      loaderData: {
        "operator/layout": {
          places: [{ mode: "operator", path: "/operator" }],
        },
        "operator/firms": {
          firms: [
            { name: "Enigma Accounting", path: "/f/enigma-accounting", member: false },
            { name: "Lovelace & Co", path: "/f/lovelace-co", member: false },
          ],
        },
      },
    });
    expect(await grace.navigate("/f/enigma-accounting")).toMatchObject({ status: 404 });
    // A firm's owner may invite an operator, who then opens it as any member does.
    const { browser: ada } = await scenario.acceptInvitation("ada@example.test", "Ada Lovelace");
    const path = await scenario.invite(ada, "/f/lovelace-co", "grace@bookkeeping.test", "admin");
    await scenario.acceptInvitation("grace@bookkeeping.test", "Grace Hopper", {
      browser: grace,
      path,
    });
    expect(await grace.navigate("/operator")).toMatchObject({
      loaderData: {
        "operator/firms": {
          firms: [
            { name: "Enigma Accounting", member: false },
            { name: "Lovelace & Co", member: true },
          ],
        },
      },
    });
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
    scenario.backoffice.failNextResponse("organizations.provisionManaged");
    expect(await ada.submit(path, { externalId, name: "Analytical Engines" })).toMatchObject({
      actionData: failed,
    });

    expect(await ada.submit(path, { externalId, name: "Analytical Engines" })).toMatchObject({
      path: "/w/analytical-engines/members",
      status: 200,
    });
    // The operators, the firm, and the client.
    assert(scenario.backoffice.organizationCount() === 3);
    expect(await ada.navigate(firmPath)).toMatchObject({
      loaderData: { "firms/dashboard": { clients: [{ name: "Analytical Engines" }] } },
    });
  });
});

test("trying again after a lost answer creates one firm and one invitation", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");
    const form = await grace.navigate("/operator/firms/new");
    const { externalId } = form.loaderData["operator/new-firm"] as { externalId: string };
    const submission = { externalId, name: "Lovelace & Co", ownerEmail: "ada@example.test" };

    // Backoffice creates the firm and its owner invitation, but Bookkeeping never hears so.
    scenario.backoffice.failNextResponse("organizations.provisionForInvitee");
    expect(await grace.submit("/operator/firms/new", submission)).toMatchObject({
      actionData: {
        status: "failed",
        externalId,
        error: "Creating the firm didn't work. Try again shortly.",
      },
    });
    expect(await grace.submit("/operator/firms/new", submission)).toMatchObject({
      actionData: {
        status: "created",
        path: "/f/lovelace-co",
        owner: { status: "invited", emailed: true },
      },
    });
    // The operators, and the firm.
    assert(scenario.backoffice.organizationCount() === 2);
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
    expect(created).toMatchObject({ actionData: { owner: { status: "invited", emailed: false } } });
    expect(scenario.backoffice.sentInvitations).toEqual([]);
    const { link } = (created.actionData as { owner: { link: string } }).owner;
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
      actionData: { status: "created", path: "/f/hopper-books", owner: { status: "you" } },
    });
    expect(scenario.backoffice.pendingInvitations("hopper-books")).toEqual([]);
    expect(await grace.navigate("/f/hopper-books")).toMatchObject({ status: 200 });
  });
});

test("every member of a firm opens its clients, and its owners and admins create them", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { firmPath, clientPath } = await scenario.practice();
    const joan = await scenario.signUp("joan@example.test", "Joan Clarke");
    // Added to the firm in Backoffice itself, so Bookkeeping learns of it when she opens the firm.
    scenario.backoffice.admin.addMember("lovelace-co", "joan@example.test", ["member"]);
    expect(await joan.navigate(firmPath)).toMatchObject({
      status: 200,
      loaderData: {
        "firms/dashboard": {
          clients: [{ name: "Analytical Engines", member: true }],
          canCreate: false,
        },
      },
    });
    expect(await joan.navigate(clientPath)).toMatchObject({
      status: 200,
      loaderData: { "clients/layout": { user: { name: "Joan Clarke", role: "Member" } } },
    });
    expect(await joan.navigate(`${firmPath}/clients/new`)).toMatchObject({ status: 403 });
    expect(
      await joan.submit(`${firmPath}/clients/new`, {
        externalId: crypto.randomUUID(),
        name: "Difference Engines",
      }),
    ).toMatchObject({ status: 403 });
    // Nor does a client open as a firm, or the other way around.
    expect(await joan.navigate("/w/lovelace-co")).toMatchObject({ status: 404 });
    expect(await joan.navigate("/f/analytical-engines")).toMatchObject({ status: 404 });
  });
});
