import { expect, test } from "vitest";

import { ARTIFACT_SITE_DATA_PERMISSIONS } from "@fragno-dev/backoffice-api/v0/artifacts";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { AUTOMATION_PAGE_RELATIONS } from "@/fragno/automation/lofi/page-relations";

/** The permission whose provider reads each relation's data. */
const RELATION_PERMISSIONS: Record<string, BackofficePermissionRequirement> = {
  runs: BACKOFFICE_PERMISSION.workflow.read,
  steps: BACKOFFICE_PERMISSION.workflow.read,
  workflow_events: BACKOFFICE_PERMISSION.workflow.read,
  workflow_waits: BACKOFFICE_PERMISSION.workflow.read,
  events: BACKOFFICE_PERMISSION.events.read,
  event_sources: BACKOFFICE_PERMISSION.events.read,
  event_definitions: BACKOFFICE_PERMISSION.events.read,
  routes: BACKOFFICE_PERMISSION.router.read,
  route_schedules: BACKOFFICE_PERMISSION.router.read,
  route_dispatches: BACKOFFICE_PERMISSION.router.read,
  projects: BACKOFFICE_PERMISSION.projects.read,
  kv_store: BACKOFFICE_PERMISSION.store.read,
  connections: BACKOFFICE_PERMISSION.connections.read,
  agents: BACKOFFICE_PERMISSION.pi.read,
  agent_turns: BACKOFFICE_PERMISSION.pi.read,
};

test("sites that read data require the permission of every relation they can read", () => {
  for (const { name } of AUTOMATION_PAGE_RELATIONS) {
    // A new relation needs a permission here, and in what sites require when it has a new one.
    expect(RELATION_PERMISSIONS, name).toHaveProperty(name);
    expect(ARTIFACT_SITE_DATA_PERMISSIONS).toContainEqual(RELATION_PERMISSIONS[name]);
  }
});
