#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")).name;

if (!pkg) {
  console.error("Missing package name in package.json");
  process.exit(1);
}

try {
  execSync(`pnpm rm -g ${pkg}`, { stdio: "ignore" });
} catch {
  // Ignore missing global install.
}

execSync("pnpm link", { stdio: "inherit" });
