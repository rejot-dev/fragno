const INVALID_PATH_SEGMENT_PATTERN = /(?:^|\/|\\)\.{1,2}(?:$|\/|\\)/;

export const normalizePathSegments = (value: string): string[] => {
  const normalized = value.trim().replaceAll("\\", "/");
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error("Path segments '.' and '..' are not allowed.");
    }
    if (segment.includes("\0")) {
      throw new Error("Null-byte characters are not allowed in paths.");
    }
  }

  return segments;
};

export const normalizeMountPoint = (mountPoint: string): string => {
  const trimmed = mountPoint.trim();
  if (trimmed.length === 0) {
    throw new Error("Mount point cannot be empty.");
  }

  if (INVALID_PATH_SEGMENT_PATTERN.test(trimmed)) {
    throw new Error("Mount point cannot contain '.' or '..' segments.");
  }

  const segments = normalizePathSegments(trimmed);
  if (segments.length === 0) {
    throw new Error("Mount point cannot be empty.");
  }

  return `/${segments.join("/")}`;
};

export const normalizeRelativePath = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return "";
  }

  if (INVALID_PATH_SEGMENT_PATTERN.test(normalized)) {
    throw new Error("Relative path cannot contain '.' or '..' segments.");
  }

  return normalizePathSegments(normalized).join("/");
};

const mountPointToSegments = (mountPoint: string): string[] => {
  if (mountPoint === "/") {
    return [];
  }

  return normalizePathSegments(mountPoint);
};

export const isMountPointParentOf = (parent: string, child: string): boolean => {
  const parentSegments = mountPointToSegments(parent);
  const childSegments = mountPointToSegments(child);

  if (parentSegments.length >= childSegments.length) {
    return false;
  }

  for (let index = 0; index < parentSegments.length; index += 1) {
    if (parentSegments[index] !== childSegments[index]) {
      return false;
    }
  }

  return true;
};

export const isExactMountPointMatch = (left: string, right: string): boolean => {
  const leftSegments = mountPointToSegments(left);
  const rightSegments = mountPointToSegments(right);

  if (leftSegments.length !== rightSegments.length) {
    return false;
  }

  for (let index = 0; index < leftSegments.length; index += 1) {
    if (leftSegments[index] !== rightSegments[index]) {
      return false;
    }
  }

  return true;
};
