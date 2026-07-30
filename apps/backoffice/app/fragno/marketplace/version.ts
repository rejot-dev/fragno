const MARKETPLACE_RELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*)`;
const MARKETPLACE_PRERELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;

export const MARKETPLACE_VERSION_PATTERN = new RegExp(
  String.raw`^${MARKETPLACE_RELEASE_IDENTIFIER}\.${MARKETPLACE_RELEASE_IDENTIFIER}\.${MARKETPLACE_RELEASE_IDENTIFIER}(?:-${MARKETPLACE_PRERELEASE_IDENTIFIER}(?:\.${MARKETPLACE_PRERELEASE_IDENTIFIER})*)?$`,
  "u",
);

type ParsedMarketplaceVersion = {
  release: readonly [bigint, bigint, bigint];
  prerelease: readonly string[] | null;
};

const parseMarketplaceVersion = (version: string): ParsedMarketplaceVersion => {
  const prereleaseSeparator = version.indexOf("-");
  const releaseSource =
    prereleaseSeparator === -1 ? version : version.slice(0, prereleaseSeparator);
  const prereleaseSource =
    prereleaseSeparator === -1 ? null : version.slice(prereleaseSeparator + 1);
  const [major, minor, patch] = releaseSource.split(".").map((part) => BigInt(part));

  return {
    release: [major, minor, patch],
    prerelease: prereleaseSource === null ? null : prereleaseSource.split("."),
  };
};

const comparePrereleaseIdentifiers = (left: string, right: string): number => {
  const leftIsNumeric = /^\d+$/u.test(left);
  const rightIsNumeric = /^\d+$/u.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  if (leftIsNumeric !== rightIsNumeric) {
    return leftIsNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};

export const compareMarketplaceVersions = (left: string, right: string): number => {
  const parsedLeft = parseMarketplaceVersion(left);
  const parsedRight = parseMarketplaceVersion(right);

  for (const index of [0, 1, 2] as const) {
    if (parsedLeft.release[index] < parsedRight.release[index]) {
      return -1;
    }
    if (parsedLeft.release[index] > parsedRight.release[index]) {
      return 1;
    }
  }

  if (parsedLeft.prerelease === null || parsedRight.prerelease === null) {
    if (parsedLeft.prerelease !== parsedRight.prerelease) {
      return parsedLeft.prerelease === null ? 1 : -1;
    }
    return left === right ? 0 : left < right ? -1 : 1;
  }

  const identifierCount = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }

    const comparison = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};
