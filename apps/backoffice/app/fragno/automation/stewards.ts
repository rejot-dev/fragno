import type { AutomationSteward } from "@fragno-dev/backoffice-api/v0/automation";

export const MEMBERS_STEWARD: AutomationSteward = { kind: "members" };

export class AutomationStewardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationStewardError";
  }
}

export function stewardsEqual(left: AutomationSteward, right: AutomationSteward) {
  return left.kind === "members"
    ? right.kind === "members"
    : right.kind === "package" && left.listingId === right.listingId;
}

export function isStewardedByPackage(steward: AutomationSteward, listingId: string) {
  return steward.kind === "package" && steward.listingId === listingId;
}

/**
 * Only a resource's steward changes its definition, though anyone may turn it on or off. A package
 * adopts a members' resource whose definition its write leaves unchanged, and one its
 * pre-stewardship install script labelled for it.
 *
 * @param resource Names the resource in refusals, such as `Automation route 'triage'`.
 */
export function assertStewardWrite({
  resource,
  steward,
  legacyListingId,
  writer,
  definitionChanged,
}: {
  resource: string;
  steward: AutomationSteward;
  legacyListingId: string | null;
  writer: AutomationSteward;
  definitionChanged: boolean;
}) {
  if (stewardsEqual(steward, writer) || !definitionChanged) {
    return;
  }
  if (steward.kind === "package") {
    throw new AutomationStewardError(
      `${resource} is managed by package '${steward.listingId}'. Only enabling or disabling it is allowed; uninstall the package to remove it.`,
    );
  }
  if (writer.kind === "package" && legacyListingId !== writer.listingId) {
    throw new AutomationStewardError(
      `${resource} already exists and is not managed by package '${writer.listingId}'.`,
    );
  }
}
