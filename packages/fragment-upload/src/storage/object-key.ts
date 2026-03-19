const OBJECT_KEY_VERSION_SEGMENT_PATTERN = /^[0-9TZ-]+$/;

const padNumber = (value: number, width: number) => value.toString().padStart(width, "0");

const formatUtcBasicTimestamp = (value: number) => {
  const date = new Date(value);
  return [
    padNumber(date.getUTCFullYear(), 4),
    padNumber(date.getUTCMonth() + 1, 2),
    padNumber(date.getUTCDate(), 2),
    "T",
    padNumber(date.getUTCHours(), 2),
    padNumber(date.getUTCMinutes(), 2),
    padNumber(date.getUTCSeconds(), 2),
    padNumber(date.getUTCMilliseconds(), 3),
    "Z",
  ].join("");
};

const normalizeObjectKeyVersionSegment = (value: string) => {
  const normalized = value.trim();
  if (!normalized || !OBJECT_KEY_VERSION_SEGMENT_PATTERN.test(normalized)) {
    throw new Error("Invalid storage object key version segment");
  }
  return normalized;
};

export const buildStorageObjectVersionSegment = (now = Date.now()) => {
  if (!Number.isFinite(now)) {
    throw new Error("Invalid storage object key version timestamp");
  }

  return formatUtcBasicTimestamp(Math.trunc(now));
};

export const appendStorageObjectKeyVersionSegment = (
  storageKey: string,
  versionSegment?: string,
  maxStorageKeyLengthBytes?: number,
) => {
  if (!versionSegment) {
    return storageKey;
  }

  const normalizedStorageKey = storageKey.replace(/\/+$/g, "");
  const versionedStorageKey = `${normalizedStorageKey}/${normalizeObjectKeyVersionSegment(versionSegment)}`;

  if (
    maxStorageKeyLengthBytes !== undefined &&
    Buffer.byteLength(versionedStorageKey, "utf8") > maxStorageKeyLengthBytes
  ) {
    throw new Error("Storage key exceeds maximum length");
  }

  return versionedStorageKey;
};
