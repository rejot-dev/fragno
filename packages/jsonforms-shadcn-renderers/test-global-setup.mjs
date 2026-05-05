import { mkdirSync } from "node:fs";

export default function globalSetup() {
  mkdirSync(new URL("./coverage/.tmp/", import.meta.url), { recursive: true });
}
