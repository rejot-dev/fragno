import {
  GraftControlStore,
  type GraftObjectAlarmWork,
  type GraftObjectLocation,
  type GraftObjectOwnership,
  type GraftObjectRoutingState,
} from "@fragno-private/backoffice-node-runtime/graft-control-store";
import type { GraftNodeAuthorityStatus } from "@fragno-private/backoffice-node-runtime/graft-node-authority";
import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";

import { demoDefaultObjectNames } from "../objects/demo-object-definition";

/** One object identity's durable location, ownership route, and alarm discovery state. */
export type ObjectControlOverview = {
  objectId: string;
  location: GraftObjectLocation | null;
  routingState: GraftObjectRoutingState | null;
  alarmWork: GraftObjectAlarmWork | null;
};

/** Machine-readable control snapshot observed through one serving runtime node. */
export type NodeDebugOverview = {
  generatedAtMs: number;
  nodeId: string;
  nodeAuthority: GraftNodeAuthorityStatus;
  objects: ObjectControlOverview[];
};

/** Reads durable object ownership from one fresh control-log clone. */
export function readObjectOwnership(
  storage: GraftNodeRuntimeStorage,
  objectId: string,
): GraftObjectOwnership | null {
  const controlStore = new GraftControlStore(storage);
  try {
    return controlStore.readObjectOwnership(objectId);
  } finally {
    controlStore.close();
  }
}

/** Reads every known or provisioned object for the demo's debugging overview. */
export function readObjectControlOverview(
  storage: GraftNodeRuntimeStorage,
): ObjectControlOverview[] {
  const controlStore = new GraftControlStore(storage);
  try {
    const locations = controlStore.readObjectLocations();
    const locationByObjectId = new Map(locations.map((location) => [location.objectId, location]));
    const objectIds = new Set([
      ...demoDefaultObjectNames.map((name) => `SHOWCASE:${name}`),
      ...locations.map((location) => location.objectId),
    ]);
    return [...objectIds].sort().map((objectId) => ({
      objectId,
      location: locationByObjectId.get(objectId) ?? null,
      routingState: controlStore.readObjectRoutingState(objectId),
      alarmWork: controlStore.readObjectAlarmWork(objectId),
    }));
  } finally {
    controlStore.close();
  }
}
