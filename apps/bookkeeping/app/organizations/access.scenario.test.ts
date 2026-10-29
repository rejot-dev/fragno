import { expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
} from "../../scenario/bookkeeping-scenario";

const CONFIRMATION_EXPIRED_MS = 61_000;

/** The practice, with Charles joined to Analytical Engines as a member through an invitation. */
async function clientWithColleague(scenario: BookkeepingScenario) {
  const { ada } = await scenario.practice();
  const path = await scenario.invite(
    ada,
    "/w/analytical-engines",
    "charles@example.test",
    "member",
  );
  const { browser: charles } = await scenario.acceptInvitation(
    "charles@example.test",
    "Charles Babbage",
    { path },
  );
  return { ada, charles };
}

test("Backoffice's membership and roles reach Bookkeeping within a minute", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, charles } = await clientWithColleague(scenario);

    scenario.backoffice.admin.setRoles("analytical-engines", "charles@example.test", ["admin"]);
    scenario.backoffice.admin.rename("analytical-engines", "Difference Engines");
    // A confirmed membership is trusted for a minute.
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: { "clients/layout": { context: { roles: ["member"] } } },
    });
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: {
        "clients/layout": {
          place: { mode: "client", name: "Difference Engines" },
          user: { name: "Charles Babbage", role: "Admin" },
        },
      },
    });

    scenario.backoffice.admin.removeMember("analytical-engines", "charles@example.test");
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({ status: 404 });
    // With nowhere left to go, Charles is told to ask for an invitation.
    expect(await charles.navigate("/start")).toMatchObject({
      path: "/start",
      loaderData: { "organizations/start": { places: [] } },
    });
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({ status: 200 });
  });
});

test("uninstalling Bookkeeping hides the client, and an outage keeps no one in", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await clientWithColleague(scenario);

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
    // Her firm is all she has left, so signing in opens it.
    expect(await ada.navigate("/start")).toMatchObject({ path: "/f/lovelace-co" });
  });
});

test("after Backoffice withdraws Bookkeeping's authorization, signing in again returns to the page", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();

    scenario.backoffice.revokeAuthorization("ada@example.test");
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    // Her Bookkeeping session is still valid, so only an explicit reauthorization shows login.
    const login = await ada.navigate("/w/analytical-engines/members");
    expect(login).toMatchObject({
      path: "/login?reauthorize=1&returnTo=%2Fw%2Fanalytical-engines%2Fmembers",
      loaderData: {
        "public/login": { returnTo: "/w/analytical-engines/members", reauthorize: true },
      },
    });
    expect(await ada.signIn("ada@example.test", "/w/analytical-engines/members")).toMatchObject({
      path: "/w/analytical-engines/members",
      status: 200,
    });
  });
});

test("the firm's people open its clients only while they are in the firm", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { clientPath } = await scenario.practice();
    const joan = await scenario.signUp("joan@example.test", "Joan Clarke");
    scenario.backoffice.admin.addMember("lovelace-co", "joan@example.test", ["member"]);
    expect(await joan.navigate(clientPath)).toMatchObject({
      status: 200,
      loaderData: { "clients/layout": { user: { role: "Member" } } },
    });
    // She acts there through the firm, so the client does not list her among its members.
    expect(await joan.navigate(`${clientPath}/members`)).toMatchObject({
      loaderData: { "clients/members": { team: { members: [], inviteRoles: [] } } },
    });

    scenario.backoffice.admin.removeMember("lovelace-co", "joan@example.test");
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await joan.navigate(clientPath)).toMatchObject({ status: 404 });
  });
});

test("a client is its firm's while Backoffice says the firm manages it", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { grace, ada, firmPath, clientPath } = await scenario.practice();
    const clientsOf = async (firm: typeof ada, path: string) =>
      (
        (await firm.navigate(path)).loaderData["firms/dashboard"] as {
          clients: { name: string }[];
        }
      ).clients.map(({ name }) => name);
    expect(await clientsOf(ada, firmPath)).toEqual(["Analytical Engines"]);

    // A Backoffice administrator ends the firm's management. The client has no member of its own
    // to tell Bookkeeping, so the firm's dashboard asks Backoffice which clients it manages.
    scenario.backoffice.admin.setManager("analytical-engines", null);
    expect(await clientsOf(ada, firmPath)).toEqual([]);
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await ada.navigate(clientPath)).toMatchObject({ status: 404 });

    // Then has another firm manage it, which lists it and opens it.
    const babbagePath = await scenario.createFirm(grace, "Babbage & Co", "joan@example.test");
    const { browser: joan } = await scenario.acceptInvitation("joan@example.test", "Joan Clarke");
    scenario.backoffice.admin.setManager("analytical-engines", "babbage-co");
    expect(await clientsOf(joan, babbagePath)).toEqual(["Analytical Engines"]);
    expect(await joan.navigate(clientPath)).toMatchObject({ status: 200 });
    expect(await clientsOf(ada, firmPath)).toEqual([]);

    // When Backoffice cannot say, the dashboard shows the clients Bookkeeping knows.
    scenario.backoffice.failNextResponse("organizations.listManaged");
    expect(await clientsOf(joan, babbagePath)).toEqual(["Analytical Engines"]);
  });
});
