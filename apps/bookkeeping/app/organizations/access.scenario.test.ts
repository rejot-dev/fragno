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

test("resubmitting the form that created a client does not let a removed owner back in", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, firmPath } = await scenario.practice();
    const path = `${firmPath}/clients/new`;
    const form = await ada.navigate(path);
    const { externalId } = form.loaderData["firms/new-client"] as { externalId: string };
    const submission = { externalId, name: "Difference Engines" };
    expect(await ada.submit(path, submission)).toMatchObject({ status: 200 });
    const invited = await scenario.invite(
      ada,
      "/w/difference-engines",
      "charles@example.test",
      "owner",
    );
    await scenario.acceptInvitation("charles@example.test", "Charles Babbage", { path: invited });

    scenario.backoffice.admin.removeMember("difference-engines", "ada@example.test");
    scenario.advanceTime(CONFIRMATION_EXPIRED_MS);
    expect(await ada.navigate("/w/difference-engines")).toMatchObject({ status: 404 });
    // Backoffice answers that the client exists; it does not make Ada its owner again.
    expect(await ada.submit(path, submission)).toMatchObject({
      path: "/w/difference-engines/members",
      status: 404,
    });
    expect(await ada.navigate("/w/difference-engines")).toMatchObject({ status: 404 });
  });
});
