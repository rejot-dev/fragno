import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Turbo restores a cache hit over the existing build output without deleting what is already
// there, so chunks of earlier builds would stay and be uploaded with the Workers. Run this before
// `turbo run build` so a hit restores exactly the cached build, and a miss builds from scratch.
const backofficeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const outputDirectory of ["dist", "build"]) {
  rmSync(path.join(backofficeDirectory, outputDirectory), { recursive: true, force: true });
}
