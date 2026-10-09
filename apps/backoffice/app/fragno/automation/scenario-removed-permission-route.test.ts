import { assert, expect, test, vi } from "vitest";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

import { createRouteBackedAutomationRouterRuntime } from "./routing-route-runtime";
import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const scope = { kind: "org", orgId: "org-1" } as const;
const action = {
  kind: "start_workflow" as const,
  authority: {
    kind: "organization-automation" as const,
    grants: [BACKOFFICE_PERMISSION.store.read],
  },
  workflowScriptPath: "/workspace/automations/sync.workflow.js",
  instanceIdTemplate: "sync-${event.id}",
};

test("a route granting a since-removed permission stays readable and editable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-removed-permission-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "route with a removed permission grant",
        options: { sqliteDataDirectory: directory },
        setup: ({ given }) => [
          given.organization.exists({ id: scope.orgId, name: "Ada Labs" }),
          given.router.route({
            orgId: scope.orgId,
            id: "repository-sync",
            name: "Repository sync",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "github",
              eventType: "webhook.received",
              matcher: null,
            },
            action,
          }),
        ],
        steps: ({ then }) => [
          then.assert("the stored grants name a permission the kernel no longer has", async () => {
            const stored = {
              ...action,
              authority: {
                ...action.authority,
                grants: [
                  { namespace: "github", permission: "read" },
                  BACKOFFICE_PERMISSION.store.read,
                ],
              },
            };
            let changed = 0;
            for (const file of await readdir(directory)) {
              if (!file.startsWith("automations-") || !file.endsWith(".sqlite")) {
                continue;
              }
              const database = new Database(path.join(directory, file));
              try {
                const tables = database
                  .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_route%' AND name NOT LIKE 'automation_route_schedule_state%'",
                  )
                  .all() as { name: string }[];
                for (const table of tables) {
                  // Historical data bypasses current validation, as data written before the removal did.
                  changed += database
                    .prepare(`UPDATE "${table.name}" SET action = ? WHERE id = ?`)
                    .run(JSON.stringify(stored), "repository-sync").changes;
                }
              } finally {
                database.close();
              }
            }
            expect(changed).toBe(1);
          }),
          then.assert(
            "reading and editing the route keep only the grants that still exist",
            async (ctx) => {
              const router = createRouteBackedAutomationRouterRuntime({
                object: ctx.runtime.objects.automations.forOrg(scope.orgId),
                execution: createBackofficeSystemExecution(scope),
              });
              const route = await router.getRoute({ id: "repository-sync" });
              assert(route);
              expect(route.action).toEqual(action);
              expect(await router.listRoutes()).toContainEqual(route);
              expect(
                await router.updateRoute({ id: route.id, name: "Renamed repository sync" }),
              ).toMatchObject({ name: "Renamed repository sync", action });
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
