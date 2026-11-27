import { expect, test, assert } from "vitest";

import type { PiAgentDefinitionCreate } from "@fragno-dev/backoffice-api/v0/pi";

import { runBookkeepingScenario } from "../../scenario/bookkeeping-scenario";
import { AGENT_PACKAGES } from "./agents";

const FIRM = "lovelace-co";
const FIRM_AGENT = "Bookkeeping agent";
const CLIENT = "analytical-engines";

/** The books package's version as Bookkeeping ships it, read before a test deploys another. */
const SHIPPED = AGENT_PACKAGES.books.version;

test("a deploy shipping a new version of an agent's package upgrades every project holding it", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath, firmPath } = await scenario.practice();
    // The firm's owner opening the firm sets up its agent project.
    await ada.navigate(firmPath);
    await scenario.openAdministration(ada, clientPath, "Engines");
    await scenario.openAdministration(ada, clientPath, "Looms");
    const installed = (version: string) => [{ listingId: "app:bookkeeping#books-agent", version }];
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed(SHIPPED));
    expect(scenario.backoffice.installedPackages(CLIENT, "Looms")).toEqual(installed(SHIPPED));
    // Bookkeeping sees the installs it started finish.
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    const installs = scenario.backoffice.operationCount("packages.install");

    const books = AGENT_PACKAGES.books;
    const instructions = "Answer from the books, briefly.";
    const declaration = JSON.parse(books.files[".marketplace/installation.json"]) as {
      agents: object[];
    };
    const files = {
      ...books.files,
      ".marketplace/installation.json": JSON.stringify({
        ...declaration,
        agents: declaration.agents.map((agent) => ({ ...agent, instructions })),
      }),
    };
    scenario.deploy({ books: { ...books, version: "2.0.0", files } });
    await scenario.runDueAlarms();
    for (const administration of ["Engines", "Looms"]) {
      expect(scenario.backoffice.installedPackages(CLIENT, administration)).toEqual(
        installed("2.0.0"),
      );
      expect(scenario.backoffice.agents(CLIENT, administration)).toMatchObject([
        { agentName: "books", instructions },
        { agentName: "company-details", instructions },
      ]);
    }
    // The firm's agent did not change, so its project is left as it was.
    expect(scenario.backoffice.installedPackages(FIRM, FIRM_AGENT)).toEqual([
      { listingId: "app:bookkeeping#bookkeeper-agent", version: AGENT_PACKAGES.bookkeeper.version },
    ]);
    expect(scenario.backoffice.operationCount("packages.install")).toBe(installs + 2);

    // Bookkeeping then sees the installs finish, and installs nothing more.
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    scenario.advanceTime(3_600_000);
    await scenario.runDueAlarms();
    expect(scenario.backoffice.operationCount("packages.install")).toBe(installs + 2);

    // While Backoffice cannot be reached, the next version waits, and is installed after.
    scenario.backoffice.setReachable(false);
    scenario.deploy({ books: { ...books, version: "2.1.0" } });
    await scenario.runDueAlarms();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed("2.0.0"));
    scenario.backoffice.setReachable(true);
    scenario.advanceTime(10_000);
    await scenario.runDueAlarms();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed("2.1.0"));
    expect(scenario.backoffice.installedPackages(CLIENT, "Looms")).toEqual(installed("2.1.0"));
  });
});

test("a rollback during an upgrade waits for the upgrade, then installs the version shipped again", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, "Engines");
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    const installed = (version: string) => [{ listingId: "app:bookkeeping#books-agent", version }];
    const installs = () => scenario.backoffice.operationCount("packages.install");
    const before = installs();

    // Backoffice is slow to run the upgrade, and Bookkeeping rolls back before it finishes.
    const books = AGENT_PACKAGES.books;
    scenario.backoffice.holdInstalls();
    scenario.deploy({ books: { ...books, version: "2.0.0" } });
    await scenario.runDueAlarms();
    assert(installs() === before + 1);
    scenario.deploy({ books });
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    // The upgrade still runs, so Bookkeeping starts nothing beside it.
    expect(installs()).toBe(before + 1);

    scenario.backoffice.finishInstalls();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed("2.0.0"));
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    await scenario.runDueAlarms();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed(SHIPPED));

    // Once it sees that install finish, Bookkeeping installs nothing more.
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    scenario.advanceTime(3_600_000);
    await scenario.runDueAlarms();
    expect(installs()).toBe(before + 2);
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed(SHIPPED));
  });
});

test("an upgrade whose start Bookkeeping never heard about is followed through a rollback", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, "Engines");
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    const installed = (version: string) => [{ listingId: "app:bookkeeping#books-agent", version }];
    const books = AGENT_PACKAGES.books;

    // Backoffice starts the upgrade, but Bookkeeping never hears its answer; then it rolls back.
    scenario.backoffice.holdInstalls();
    scenario.backoffice.failNextResponse("packages.install");
    scenario.deploy({ books: { ...books, version: "2.0.0" } });
    await scenario.runDueAlarms();
    scenario.deploy({ books });
    scenario.advanceTime(10_000);
    await scenario.runDueAlarms();

    // Asking for the upgrade again found it running, so Bookkeeping follows it to its end.
    scenario.backoffice.finishInstalls();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed("2.0.0"));
    scenario.advanceTime(3_600_000);
    await scenario.runDueAlarms();
    await scenario.runDueAlarms();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual(installed(SHIPPED));
  });
});

test("a version Backoffice refused to install, as one never published, gives way to the next", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, "Engines");
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    const books = AGENT_PACKAGES.books;

    scenario.deployBeforePublishing({ books: { ...books, version: "2.0.0" } });
    await scenario.runDueAlarms();
    scenario.deploy({ books: { ...books, version: "2.1.0" } });
    scenario.advanceTime(10_000);
    await scenario.runDueAlarms();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual([
      { listingId: "app:bookkeeping#books-agent", version: "2.1.0" },
    ]);
  });
});

test("an agent the client's members defined under the package's name blocks its install, which Bookkeeping retries ever later until they delete it", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, "Engines");
    // As before Bookkeeping shipped its agents as packages: the project's agent is the members'.
    scenario.backoffice.admin.uninstall(CLIENT);
    scenario.backoffice.admin.uninstallPackage(CLIENT, "Engines", "app:bookkeeping#books-agent");
    scenario.backoffice.admin.defineAgent(CLIENT, "Engines", {
      ...booksAgent(),
      instructions: "The instructions Bookkeeping wrote before.",
    });
    scenario.backoffice.admin.reinstall(CLIENT);
    const installs = () => scenario.backoffice.operationCount("packages.install");
    scenario.deploy({ books: { ...AGENT_PACKAGES.books, version: "2.0.0" } });
    await scenario.runDueAlarms();
    assert(installs() === 2);

    // The install failed; Bookkeeping waits before each next one, longer each time.
    for (let second = 0; second < 120; second += 5) {
      scenario.advanceTime(5_000);
      // oxlint-disable-next-line no-await-in-loop
      await scenario.runDueAlarms();
    }
    expect(installs()).toBeLessThanOrEqual(6);
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual([]);
    expect(scenario.backoffice.agents(CLIENT, "Engines")).toMatchObject([
      { agentName: "books", steward: { kind: "members" } },
    ]);

    // Once the members delete their agent, the next attempt installs the package.
    scenario.backoffice.admin.deleteAgent(CLIENT, "Engines", "books");
    scenario.advanceTime(3_600_000);
    await scenario.runDueAlarms();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual([
      { listingId: "app:bookkeeping#books-agent", version: "2.0.0" },
    ]);
  });
});

test("an agent Bookkeeping defined before it shipped packages, which the members left as it was, becomes the package's", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, "Engines");
    // As before Bookkeeping shipped its agents as packages: the members' agent, as Bookkeeping wrote it.
    scenario.backoffice.admin.uninstall(CLIENT);
    scenario.backoffice.admin.uninstallPackage(CLIENT, "Engines", "app:bookkeeping#books-agent");
    scenario.backoffice.admin.defineAgent(CLIENT, "Engines", booksAgent());
    scenario.backoffice.admin.reinstall(CLIENT);

    scenario.deploy({ books: { ...AGENT_PACKAGES.books, version: "2.0.0" } });
    // Bookkeeping sees its first install finish, then installs the new version.
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();
    await scenario.runDueAlarms();
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual([
      { listingId: "app:bookkeeping#books-agent", version: "2.0.0" },
    ]);
    const packaged = { kind: "package", listingId: "app:bookkeeping#books-agent" };
    expect(scenario.backoffice.agents(CLIENT, "Engines")).toMatchObject([
      { agentName: "books", steward: packaged },
      { agentName: "company-details", steward: packaged },
    ]);
  });
});

test("a client secret Backoffice no longer accepts fails the alarm instead of being retried as an outage", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, "Engines");
    scenario.advanceTime(5_000);
    await scenario.runDueAlarms();

    scenario.backoffice.admin.rotateClientSecret();
    scenario.deploy({ books: { ...AGENT_PACKAGES.books, version: "2.0.0" } });
    await expect(scenario.runDueAlarms()).rejects.toThrow(
      "Bookkeeping could not authenticate to Backoffice (HTTP 401).",
    );
    expect(scenario.backoffice.installedPackages(CLIENT, "Engines")).toEqual([
      { listingId: "app:bookkeeping#books-agent", version: SHIPPED },
    ]);
  });
});

/** The first agent the books' package defines, as its declaration does. */
function booksAgent() {
  const declaration = JSON.parse(AGENT_PACKAGES.books.files[".marketplace/installation.json"]) as {
    agents: PiAgentDefinitionCreate[];
  };
  return declaration.agents[0];
}
