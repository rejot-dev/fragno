const INVALID_PATH_SEGMENT_PATTERN = /(?:^|\/|\\)\.{1,2}(?:$|\/|\\)/;

function normalizePathSegments(value: string): string[] {
  const segments = value
    .trim()
    .replaceAll("\\", "/")
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
}

/** Normalizes artifact paths while rejecting traversal and null bytes. */
export function normalizeAbsolutePath(value: string): string {
  const segments = normalizePathSegments(value);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** Normalizes automation source paths without permitting traversal segments. */
export function normalizeRelativePath(value: string): string {
  const normalized = value.trim();
  if (INVALID_PATH_SEGMENT_PATTERN.test(normalized)) {
    throw new Error("Relative path cannot contain '.' or '..' segments.");
  }
  return normalizePathSegments(normalized).join("/");
}

/** Tests artifact ownership using complete path segments rather than string prefixes. */
export function isPathWithin(path: string, parent: string): boolean {
  const normalizedPath = normalizeAbsolutePath(path);
  const normalizedParent = normalizeAbsolutePath(parent);
  return (
    normalizedPath === normalizedParent ||
    normalizedParent === "/" ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}
