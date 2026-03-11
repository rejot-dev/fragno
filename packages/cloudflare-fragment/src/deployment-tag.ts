export const DEFAULT_DEPLOYMENT_TAG_PREFIX = "fragno";

const MAX_TAG_LENGTH = 63;
const APP_TAG_SEGMENT = "app";
const DEPLOYMENT_TAG_SEGMENT = "dep";

export const sanitizeCloudflareTag = (value: string) => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/--+/g, "-");
};

export const normalizeCloudflareDeploymentTagPrefix = (prefix?: string) => {
  const normalized = sanitizeCloudflareTag(prefix ?? DEFAULT_DEPLOYMENT_TAG_PREFIX);
  if (!normalized) {
    throw new Error(
      "Cloudflare deployment tag prefix must contain at least one alphanumeric character.",
    );
  }

  return normalized;
};

const trimTrailingHyphens = (value: string) => value.replace(/-+$/, "");

const capCloudflareTagPrefix = (
  prefix: string,
  kind: string,
  normalizedId: string,
  label: string,
) => {
  const maxPrefixLength = MAX_TAG_LENGTH - `-${kind}-`.length - normalizedId.length;
  if (maxPrefixLength < 1) {
    throw new Error(
      `Cloudflare ${label} tag '${normalizedId}' exceeds the ${MAX_TAG_LENGTH} character limit even with the shortest possible prefix.`,
    );
  }

  const cappedPrefix = trimTrailingHyphens(prefix.slice(0, maxPrefixLength));
  if (!cappedPrefix) {
    throw new Error(
      `Cloudflare ${label} tag prefix must retain at least one alphanumeric character after capping.`,
    );
  }

  return cappedPrefix;
};

const buildCloudflareScopedTag = (
  id: string,
  prefix: string | undefined,
  kind: string,
  label: string,
) => {
  const normalizedPrefix = normalizeCloudflareDeploymentTagPrefix(prefix);
  const normalizedId = sanitizeCloudflareTag(id);

  if (!normalizedId) {
    throw new Error(`Cloudflare ${label} id must contain at least one alphanumeric character.`);
  }

  const cappedPrefix = capCloudflareTagPrefix(normalizedPrefix, kind, normalizedId, label);
  return `${cappedPrefix}-${kind}-${normalizedId}`;
};

const readCloudflareScopedTagId = (
  tag: string,
  prefix: string | undefined,
  kind: string,
  label: string,
) => {
  const normalizedTag = sanitizeCloudflareTag(tag);
  const marker = `-${kind}-`;
  const normalizedPrefix = normalizeCloudflareDeploymentTagPrefix(prefix);
  let markerIndex = normalizedTag.indexOf(marker);

  while (markerIndex >= 1) {
    const normalizedId = normalizedTag.slice(markerIndex + marker.length);
    if (normalizedId) {
      try {
        const expectedPrefix = capCloudflareTagPrefix(normalizedPrefix, kind, normalizedId, label);
        const tagPrefix = normalizedTag.slice(0, markerIndex);
        if (tagPrefix === expectedPrefix) {
          return normalizedId;
        }
      } catch {
        // Ignore unrelated tags that happen to contain the same marker.
      }
    }

    markerIndex = normalizedTag.indexOf(marker, markerIndex + 1);
  }

  return null;
};

const findCloudflareScopedTag = (
  tags: string[],
  prefix: string | undefined,
  kind: string,
  label: string,
) => {
  const marker = `-${kind}-`;

  for (const tag of tags) {
    const normalizedTag = sanitizeCloudflareTag(tag);
    if (!normalizedTag.includes(marker)) {
      continue;
    }

    const id = readCloudflareScopedTagId(normalizedTag, prefix, kind, label);
    if (id !== null) {
      return normalizedTag;
    }
  }

  return null;
};

export const buildCloudflareAppTag = (appId: string, prefix?: string) => {
  return buildCloudflareScopedTag(appId, prefix, APP_TAG_SEGMENT, "app");
};

export const buildCloudflareDeploymentTag = (deploymentId: string, prefix?: string) => {
  return buildCloudflareScopedTag(deploymentId, prefix, DEPLOYMENT_TAG_SEGMENT, "deployment");
};

export const getCloudflareAppIdFromTag = (tag: string, prefix?: string) => {
  return readCloudflareScopedTagId(tag, prefix, APP_TAG_SEGMENT, "app");
};

export const getCloudflareDeploymentIdFromTag = (tag: string, prefix?: string) => {
  return readCloudflareScopedTagId(tag, prefix, DEPLOYMENT_TAG_SEGMENT, "deployment");
};

export const findCloudflareAppTag = (tags: string[], prefix?: string) => {
  return findCloudflareScopedTag(tags, prefix, APP_TAG_SEGMENT, "app");
};

export const findCloudflareDeploymentTag = (tags: string[], prefix?: string) => {
  return findCloudflareScopedTag(tags, prefix, DEPLOYMENT_TAG_SEGMENT, "deployment");
};
