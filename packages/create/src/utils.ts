import fs from "node:fs";
import path from "node:path";

export function mkdirp(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code === "EEXIST") {
      return;
    }
    throw e;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Deep merge plain objects. Arrays and primitives are overwritten, not merged.
 * @param target The target object
 * @param source The source object
 * @returns The merged object
 */
export function merge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = merge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }

  return result as T;
}

function identity<T>(x: T): T {
  return x;
}

export function copy(
  from: string,
  to: string,
  rename: (basename: string) => string = identity,
): void {
  if (!fs.existsSync(from)) {
    return;
  }

  const stats = fs.statSync(from);

  if (stats.isDirectory()) {
    fs.readdirSync(from).forEach((file) => {
      copy(path.join(from, file), path.join(to, rename(file)));
    });
  } else {
    mkdirp(path.dirname(to));
    fs.copyFileSync(from, to);
  }
}
