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
 * takes over a members' resource its pre-stewardship install script labelled for it, and, where
 * `adoptsIdentical`, an unlabelled one its write leaves unchanged. It never takes over another
 * package's, and nothing changes what Backoffice defines.
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
  writer: AutomationSteward;
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
  // The resource is the members', so the writer is a package.
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
