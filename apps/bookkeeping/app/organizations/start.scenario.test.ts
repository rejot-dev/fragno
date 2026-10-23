import { expect, test } from "vitest";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";

const INVITATION_EXPIRED_MS = 49 * 60 * 60 * 1000;

test("someone who signs in without opening the email finds their invitations", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const grace = await scenario.signUp("grace@bookkeeping.test", "Grace Hopper");
    scenario.setOperators("grace@bookkeeping.test");
    await scenario.createFirm(grace, "Lovelace & Co", "ada@example.test");

    // Ada signs in from Bookkeeping's home page instead of the invitation link.
    const ada = await scenario.signUp("ada@example.test", "Ada Lovelace");
    const lovelace = scenario.invitationPath("ada@example.test");
    expect(await ada.navigate("/start")).toMatchObject({
      path: "/start",
      loaderData: {
        "organizations/start": {
          places: [],
          invitations: [
            {
              path: lovelace,
              invitedTo: "the accounting firm Lovelace & Co",
              role: "owner",
              invitedBy: "Grace Hopper",
            },
          ],
        },
      },
    });
    expect(await ada.submit(lovelace, {})).toMatchObject({ path: "/f/lovelace-co" });
    // Accepted, the invitation is gone, so signing in opens her only firm.
    expect(await ada.navigate("/start")).toMatchObject({ path: "/f/lovelace-co" });

    // A second firm's invitation keeps her on the choice, beside the firm she has.
    await scenario.createFirm(grace, "Babbage Books", "ada@example.test");
    expect(await ada.navigate("/start")).toMatchObject({
      path: "/start",
      loaderData: {
        "organizations/start": {
          places: [{ mode: "firm", name: "Lovelace & Co" }],
          invitations: [{ invitedTo: "the accounting firm Babbage Books" }],
        },
      },
    });

    // An expired invitation is no longer offered.
    scenario.advanceTime(INVITATION_EXPIRED_MS);
    expect(await ada.navigate("/start")).toMatchObject({ path: "/f/lovelace-co" });
  });
});
