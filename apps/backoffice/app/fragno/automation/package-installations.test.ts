import { describe, expect, test } from "vitest";

import type { AutomationRouteCreateInput } from "@fragno-dev/backoffice-api/v0/automation";
import type { AutomationEventDefinitionCreateInput } from "@fragno-dev/backoffice-api/v0/events";
import type { PackageInstallation } from "@fragno-dev/backoffice-api/v0/marketplace";

import { InMemoryAdapter } from "@fragno-dev/db";

import type { AutomationWorkflowsService } from "./definition";
import { createAutomationFragment } from "./index";
import { applyPackageInstallation, uninstallPackage } from "./package-installations";
import { automationFragmentSchema } from "./schema";
import { MEMBERS_STEWARD } from "./stewards";
import { createTestAutomationSourceReader } from "./test-automation-source-reader.test-utils";

const LISTING_ID = "system#github-channel";
const OTHER_LISTING_ID = "system#other-channel";

const actors = {
  initiator: {
    scope: "internal",
    type: "system",
    id: "package-installations-test",
    role: "initiator",
  },
  principal: null,
  delegation: [],
} as const;

const noOpWorkflows = {
  createInstance: async () => ({}),
  getInstanceStatus: async () => [],
  sendEvent: async () => ({}),
} as unknown as AutomationWorkflowsService;

/** One install run, which may write its installation again; nothing was installed before it. */
const FIRST_RUN = { operation: "run-1", expectedOperation: null };

const installation: PackageInstallation = {
  marketplace: { kind: "system" },
  listingId: LISTING_ID,
  version: "1.2.0",
  installationRoot: "/workspace/github",
  permissions: [],
  settings: {},
};

function pushRoute(
  overrides: Partial<AutomationRouteCreateInput> = {},
): AutomationRouteCreateInput {
  return {
    id: "github-push-reclassify",
    name: "Classify GitHub pushes",
    enabled: true,
    priority: 40,
    trigger: {
      kind: "event",
      source: "github",
      eventType: "webhook.received",
      matcher: { path: "$.payload.githubEvent", op: "eq", value: "push" },
    },
    action: {
      kind: "reclassify_event",
      source: "github",
      eventType: "push",
      payload: { kind: "projection", fields: { ref: "$.payload.raw.ref" } },
    },
    ...overrides,
  } as AutomationRouteCreateInput;
}

const pushDefinition: AutomationEventDefinitionCreateInput = {
  source: "github",
  eventType: "push",
  label: "GitHub push",
  description: "Fires when GitHub reports a repository push.",
  payloadSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  enabled: true,
};

function createFragment(seed: string) {
  return createAutomationFragment(
    {
      builtInEventDefinitions: [],
      ownerScope: { kind: "org", orgId: "org_123" },
      readAutomationSource: createTestAutomationSourceReader({}),
    },
    { databaseAdapter: new InMemoryAdapter({ idSeed: seed }), outbox: { enabled: true } },
    { workflows: noOpWorkflows },
  );
}

type Fragment = ReturnType<typeof createFragment>;

/** Writes a route as install scripts did before stewardship, labelled with `managedBy`. */
async function seedLegacyLabelledRoute(
  fragment: Fragment,
  route: AutomationRouteCreateInput,
  managedBy: { kind: "marketplace"; listingId: string } | null,
) {
  await fragment.inContext(async function () {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const uow = forSchema(automationFragmentSchema);
        uow.create("automation_route", {
          id: route.id,
          name: route.name,
          enabled: route.enabled,
          priority: route.priority,
          trigger: route.trigger,
          action: route.action,
          description: null,
          metadata: { createdByActors: actors, updatedByActors: actors, managedBy },
          createdAt: uow.now(),
          updatedAt: uow.now(),
        });
      })
      .execute();
  });
}

async function readRoute(fragment: Fragment, id: string) {
  return await fragment.callServices(() => fragment.services.getRoute({ id }));
}

async function readDefinition(fragment: Fragment) {
  return await fragment.callServices(() =>
    fragment.services.getEventDefinition({ source: "github", eventType: "push" }),
  );
}

describe("package installations", () => {
  test("takes over the routes its pre-stewardship install script labelled, then removes them on uninstall", async () => {
    const fragment = createFragment("legacy-route-adoption");
    await seedLegacyLabelledRoute(fragment, pushRoute({ name: "Old name" }), {
      kind: "marketplace",
      listingId: LISTING_ID,
    });
    expect((await readRoute(fragment, "github-push-reclassify"))?.steward).toEqual(MEMBERS_STEWARD);

    await expect(
      applyPackageInstallation(fragment, {
        installation,
        ...FIRST_RUN,
        routes: [pushRoute()],
        eventDefinitions: [],
        actors,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(readRoute(fragment, "github-push-reclassify")).resolves.toMatchObject({
      name: "Classify GitHub pushes",
      steward: { kind: "package", listingId: LISTING_ID },
    });

    await expect(uninstallPackage(fragment, { listingId: LISTING_ID })).resolves.toMatchObject({
      removedRouteIds: ["github-push-reclassify"],
    });
    await expect(readRoute(fragment, "github-push-reclassify")).resolves.toBeNull();
  });

  test.each([
    ["another package labelled", { kind: "marketplace", listingId: OTHER_LISTING_ID } as const],
    ["members wrote", null],
  ])("refuses to change a route %s, leaving it as it was", async (_case, managedBy) => {
    const fragment = createFragment(`legacy-route-refusal-${managedBy?.listingId ?? "members"}`);
    await seedLegacyLabelledRoute(fragment, pushRoute({ name: "Old name" }), managedBy);

    await expect(
      applyPackageInstallation(fragment, {
        installation,
        ...FIRST_RUN,
        routes: [pushRoute()],
        eventDefinitions: [],
        actors,
      }),
    ).resolves.toEqual({
      ok: false,
      message: `Automation route 'github-push-reclassify' already exists and is not managed by package '${LISTING_ID}'.`,
    });
    await expect(readRoute(fragment, "github-push-reclassify")).resolves.toMatchObject({
      name: "Old name",
      steward: MEMBERS_STEWARD,
    });
    await expect(
      fragment.callServices(() =>
        fragment.services.getPackageInstallation({ listingId: LISTING_ID }),
      ),
    ).resolves.toBeNull();
  });

  test("defines its declared events, which only toggles change, and deletes them when no longer declared", async () => {
    const fragment = createFragment("declared-event-definitions");
    await expect(
      applyPackageInstallation(fragment, {
        installation,
        ...FIRST_RUN,
        routes: [],
        eventDefinitions: [pushDefinition],
        actors,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(readDefinition(fragment)).resolves.toMatchObject({
      label: "GitHub push",
      steward: { kind: "package", listingId: LISTING_ID },
    });

    await expect(
      fragment.callServices(() =>
        fragment.services.updateEventDefinition(
          { source: "github", eventType: "push", patch: { label: "Renamed" } },
          MEMBERS_STEWARD,
        ),
      ),
    ).rejects.toThrow(
      `Event definition 'github/push' is managed by package '${LISTING_ID}'. Only enabling or disabling it is allowed; uninstall the package to remove it.`,
    );
    await fragment.callServices(() =>
      fragment.services.updateEventDefinition(
        { source: "github", eventType: "push", patch: { enabled: false } },
        MEMBERS_STEWARD,
      ),
    );

    await applyPackageInstallation(fragment, {
      installation,
      ...FIRST_RUN,
      routes: [],
      eventDefinitions: [{ ...pushDefinition, label: "GitHub push received" }],
      actors,
    });
    await expect(readDefinition(fragment)).resolves.toMatchObject({
      label: "GitHub push received",
      enabled: false,
      steward: { kind: "package", listingId: LISTING_ID },
    });

    await applyPackageInstallation(fragment, {
      installation,
      ...FIRST_RUN,
      routes: [],
      eventDefinitions: [],
      actors,
    });
    await expect(readDefinition(fragment)).resolves.toBeNull();
  });

  test("takes over an identical definition members created, but not a different one", async () => {
    const adopting = createFragment("adopt-identical-event-definition");
    await adopting.callServices(() =>
      adopting.services.createEventDefinition(pushDefinition, MEMBERS_STEWARD),
    );
    await expect(
      applyPackageInstallation(adopting, {
        installation,
        ...FIRST_RUN,
        routes: [],
        eventDefinitions: [pushDefinition],
        actors,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(readDefinition(adopting)).resolves.toMatchObject({
      steward: { kind: "package", listingId: LISTING_ID },
    });
    await expect(uninstallPackage(adopting, { listingId: LISTING_ID })).resolves.toMatchObject({
      removedEventDefinitions: [{ source: "github", eventType: "push" }],
    });
    await expect(readDefinition(adopting)).resolves.toBeNull();

    const refusing = createFragment("refuse-different-event-definition");
    await refusing.callServices(() =>
      refusing.services.createEventDefinition(
        { ...pushDefinition, label: "Our own push" },
        MEMBERS_STEWARD,
      ),
    );
    await expect(
      applyPackageInstallation(refusing, {
        installation,
        ...FIRST_RUN,
        routes: [],
        eventDefinitions: [pushDefinition],
        actors,
      }),
    ).resolves.toEqual({
      ok: false,
      message: `Event definition 'github/push' already exists and is not managed by package '${LISTING_ID}'.`,
    });
    await expect(readDefinition(refusing)).resolves.toMatchObject({
      label: "Our own push",
      steward: MEMBERS_STEWARD,
    });
  });

  test("commits only one of two runs that read the same installation, and none after an uninstall", async () => {
    const fragment = createFragment("overlapping-runs");
    await applyPackageInstallation(fragment, {
      installation: { ...installation, version: "1.0.0" },
      ...FIRST_RUN,
      routes: [],
      eventDefinitions: [],
      actors,
    });
    const upgrade = (version: string, routeId: string) =>
      applyPackageInstallation(fragment, {
        installation: { ...installation, version },
        operation: `run-${version}`,
        expectedOperation: FIRST_RUN.operation,
        routes: [pushRoute({ id: routeId })],
        eventDefinitions: [],
        actors,
      });

    const outcomes = await Promise.all([
      upgrade("2.0.0", "route-from-2"),
      upgrade("3.0.0", "route-from-3"),
    ]);
    const changed = {
      ok: false,
      message: `Package '${LISTING_ID}' was installed or uninstalled elsewhere while this ran. Try again.`,
    };
    expect(outcomes).toContainEqual({ ok: true });
    expect(outcomes).toContainEqual(changed);
    const record = await fragment.callServices(() =>
      fragment.services.getPackageInstallationRecord({ listingId: LISTING_ID }),
    );
    const routes = await fragment.callServices(() => fragment.services.listRoutes());
    expect(routes.map((route) => route.id)).toEqual([
      record?.installation.version === "2.0.0" ? "route-from-2" : "route-from-3",
    ]);

    await uninstallPackage(fragment, { listingId: LISTING_ID });
    await expect(upgrade("4.0.0", "route-from-4")).resolves.toEqual(changed);
    await expect(fragment.callServices(() => fragment.services.listRoutes())).resolves.toEqual([]);
  });

  test("refuses a declared event that a built-in catalog event already defines", async () => {
    const fragment = createFragment("reserved-event-definition");
    await expect(
      applyPackageInstallation(fragment, {
        installation,
        ...FIRST_RUN,
        routes: [],
        eventDefinitions: [{ ...pushDefinition, eventType: "webhook.received" }],
        actors,
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Automation event definition source/type is reserved by a built-in catalog event.",
    });
  });
});
