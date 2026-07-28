const OBJECT_KEY_VERSION_SEGMENT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeObjectKeyVersionSegment = (value: string) => {
  const normalized = value.trim();
  if (!normalized || !OBJECT_KEY_VERSION_SEGMENT_PATTERN.test(normalized)) {
    throw new Error("Invalid storage object key version segment");
  }
  return normalized;
};

export const buildStorageObjectVersionSegment = () => crypto.randomUUID();

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
