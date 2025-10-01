import fs from "node:fs";
import path from "node:path";

export function mkdirp(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code === "EEXIST") return;
    throw e;
  }
}

function identity<T>(x: T): T {
  return x;
}

export function copy(
  from: string,
  to: string,
  rename: (basename: string) => string = identity,
): void {
  if (!fs.existsSync(from)) return;

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
