import type {
  AutomationActors,
  AutomationRouteAction,
  AutomationRouteSteward,
  AutomationSteward,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { PiAgentSteward } from "@fragno-dev/backoffice-api/v0/pi";

import { installedAppIdOfActors } from "@/fragno/app-installations/authority";

/**
 * Event definitions have the automation stewards; routes may also be an installed app's, and agents
 * Backoffice's.
 */
type Steward = PiAgentSteward | AutomationRouteSteward;

export const MEMBERS_STEWARD: AutomationSteward = { kind: "members" };

export class AutomationStewardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationStewardError";
  }
}

export function stewardsEqual(left: Steward, right: Steward) {
  if (left.kind === "package") {
    return right.kind === "package" && left.listingId === right.listingId;
  }
  if (left.kind === "app") {
    return right.kind === "app" && left.appId === right.appId;
  }
  return left.kind === right.kind;
}

/** An installed app stewards the routes it writes with its credential; others write as members. */
export function automationRouteWriter(actors: AutomationActors): AutomationRouteSteward {
  const appId = installedAppIdOfActors(actors);
  return appId === null ? MEMBERS_STEWARD : { kind: "app", appId };
}

/**
 * An app's routes only tell the app about events. Any other action would act in the owner's scope
 * on the app's say, with the authority of whoever the route acts for.
 */
export function assertAppRouteNotifiesItself({
  routeId,
  writer,
  action,
}: {
  routeId: string;
  writer: AutomationRouteSteward;
  action: AutomationRouteAction;
}) {
  if (writer.kind === "app" && (action.kind !== "notify_app" || action.appId !== writer.appId)) {
    throw new AutomationStewardError(
      `Automation route '${routeId}' is written by app '${writer.appId}', which may only notify itself.`,
    );
  }
}

export function isStewardedByPackage(steward: Steward, listingId: string) {
  return steward.kind === "package" && steward.listingId === listingId;
}

/**
 * Only a resource's steward changes its definition, though anyone may turn it on or off. A package
 * takes over a members' resource its pre-stewardship install script labelled for it, and, where
 * `adoptsIdentical`, an unlabelled one its write leaves unchanged. It never takes over another
 * package's, and nothing changes what Backoffice defines. An installed app only writes its own.
 *
 * @param resource Names the resource in refusals, such as `Automation route 'triage'`.
 * @param toggleable Whether the resource can be turned on or off, which agents can't.
 * @param adoptsIdentical Whether a package takes over an identical members' resource, for kinds
 *   that install scripts created without a label.
 */
export function assertStewardWrite({
  resource,
  steward,
  legacyListingId,
  writer,
  definitionChanged,
  toggleable,
  adoptsIdentical,
}: {
  resource: string;
  steward: Steward;
  legacyListingId: string | null;
  writer: AutomationRouteSteward;
  definitionChanged: boolean;
  toggleable: boolean;
  adoptsIdentical: boolean;
}) {
  if (steward.kind === "backoffice") {
    throw new AutomationStewardError(`${resource} is built into Backoffice and cannot change.`);
  }
  if (stewardsEqual(steward, writer)) {
    return;
  }
  if (steward.kind === "package") {
    // Members may still turn it on or off; another package may not touch it at all.
    if (writer.kind === "members" && !definitionChanged) {
      return;
    }
    throw new AutomationStewardError(
      `${resource} is managed by package '${steward.listingId}'. ${toggleable ? "Only enabling or disabling it is allowed; uninstall" : "Install the package again to change it, or uninstall"} the package to remove it.`,
    );
  }
  if (steward.kind === "app") {
    // Members may still turn it on or off, or delete it, e.g. once the app is uninstalled.
    if (writer.kind === "members" && !definitionChanged) {
      return;
    }
    throw new AutomationStewardError(
      `${resource} is managed by app '${steward.appId}'. Only enabling, disabling, or deleting it is allowed.`,
    );
  }
  // The resource is the members'.
  if (writer.kind === "app") {
    throw new AutomationStewardError(`${resource} is not managed by app '${writer.appId}'.`);
  }
  if (
    writer.kind === "package" &&
    legacyListingId !== writer.listingId &&
    !(adoptsIdentical && !definitionChanged)
  ) {
    throw new AutomationStewardError(
      `${resource} already exists and is not managed by package '${writer.listingId}'.`,
    );
  }
}
