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

export const normalizeAbsolutePath = (value: string): string => {
  const segments = normalizePathSegments(value);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

export const stripTrailingSlash = (value: string): string => {
  if (value === "/") {
    return value;
  }

  return value.replace(/\/+$/, "");
};

export const ensureFolderPath = (value: string): string => {
  if (value === "/") {
    return value;
  }

  return value.endsWith("/") ? value : `${value}/`;
};

export const normalizeFolderPath = (value: string): string =>
  ensureFolderPath(normalizeAbsolutePath(value));

export const normalizeDirectoryPath = (value: string): string => {
  const normalized = normalizeAbsolutePath(value);
  return normalized === "/" || !value.trim().endsWith("/")
    ? normalized
    : ensureFolderPath(normalized);
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

export const isPathWithin = (path: string, parent: string): boolean => {
  const normalizedPath = stripTrailingSlash(normalizeAbsolutePath(path)) || "/";
  const normalizedParent = stripTrailingSlash(normalizeAbsolutePath(parent)) || "/";

  return (
    normalizedPath === normalizedParent ||
    (normalizedParent === "/" && normalizedPath !== "/") ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
};

export const resolvePath = (base: string, path: string): string => {
  if (path.startsWith("/")) {
    return normalizeAbsolutePath(path);
  }

  const resolved = normalizeAbsolutePath(base).split("/").filter(Boolean);
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return `/${resolved.join("/")}`;
};
