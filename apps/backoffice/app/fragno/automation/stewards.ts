import type { AutomationSteward } from "@fragno-dev/backoffice-api/v0/automation";
import type { PiAgentSteward } from "@fragno-dev/backoffice-api/v0/pi";

/** Routes and event definitions have the automation stewards; agents may also be Backoffice's. */
type Steward = PiAgentSteward;

export const MEMBERS_STEWARD: AutomationSteward = { kind: "members" };

export class AutomationStewardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationStewardError";
  }
}

export function stewardsEqual(left: Steward, right: Steward) {
  return left.kind === "package"
    ? right.kind === "package" && left.listingId === right.listingId
    : left.kind === right.kind;
}

export function isStewardedByPackage(steward: Steward, listingId: string) {
  return steward.kind === "package" && steward.listingId === listingId;
}

/**
 * Only a resource's steward changes its definition, though anyone may turn it on or off. A package
 * adopts a members' resource whose definition its write leaves unchanged, and one its
 * pre-stewardship install script labelled for it. Nothing changes what Backoffice defines.
 *
 * @param resource Names the resource in refusals, such as `Automation route 'triage'`.
 * @param toggleable Whether the resource can be turned on or off, which agents can't.
 */
export function assertStewardWrite({
  resource,
  steward,
  legacyListingId,
  writer,
  definitionChanged,
  toggleable,
}: {
  resource: string;
  steward: Steward;
  legacyListingId: string | null;
  writer: AutomationSteward;
  definitionChanged: boolean;
  toggleable: boolean;
}) {
  if (steward.kind === "backoffice") {
    throw new AutomationStewardError(`${resource} is built into Backoffice and cannot change.`);
  }
  if (stewardsEqual(steward, writer) || !definitionChanged) {
    return;
  }
  if (steward.kind === "package") {
    throw new AutomationStewardError(
      `${resource} is managed by package '${steward.listingId}'. ${toggleable ? "Only enabling or disabling it is allowed; uninstall" : "Install the package again to change it, or uninstall"} the package to remove it.`,
    );
  }
  if (writer.kind === "package" && legacyListingId !== writer.listingId) {
    throw new AutomationStewardError(
      `${resource} already exists and is not managed by package '${writer.listingId}'.`,
    );
  }
}
