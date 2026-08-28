import { afterEach, assert, describe, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReactRouterWorkerPreviewDevVars } from "./react-router-worker-preview-dev-vars-vite-plugin";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("React Router Worker preview dev vars", () => {
  it("includes only secrets assigned to the route Worker", () => {
    const directory = createTemporaryDirectory();
    const wranglerConfigPath = path.join(directory, "wrangler.jsonc");
    writeFileSync(wranglerConfigPath, "{}");
    writeFileSync(
      path.join(directory, ".dev.vars"),
      [
        "AUTH_ADMIN_GRANT_TOKEN=admin-token",
        "GITHUB_APP_WEBHOOK_SECRET=webhook token",
        "OPENAI_API_KEY=unrelated-secret",
        "",
      ].join("\n"),
    );

    const source = createReactRouterWorkerPreviewDevVars({
      wranglerConfigPath,
      secretNames: ["AUTH_ADMIN_GRANT_TOKEN", "GITHUB_APP_WEBHOOK_SECRET"],
    });

    assert.equal(
      source,
      "AUTH_ADMIN_GRANT_TOKEN='admin-token'\nGITHUB_APP_WEBHOOK_SECRET='webhook token'\n",
    );
  });

  it("preserves secret values containing dotenv quote characters", () => {
    const directory = createTemporaryDirectory();
    const wranglerConfigPath = path.join(directory, "wrangler.jsonc");
    writeFileSync(wranglerConfigPath, "{}");
    writeFileSync(path.join(directory, ".dev.vars"), "AUTH_ADMIN_GRANT_TOKEN=it's-secret\n");

    const source = createReactRouterWorkerPreviewDevVars({
      wranglerConfigPath,
      secretNames: ["AUTH_ADMIN_GRANT_TOKEN"],
    });

    assert.equal(source, "AUTH_ADMIN_GRANT_TOKEN=`it's-secret`\n");
  });

  it("does not create content when assigned secrets are not locally configured", () => {
    const directory = createTemporaryDirectory();
    const wranglerConfigPath = path.join(directory, "wrangler.jsonc");
    writeFileSync(wranglerConfigPath, "{}");
    writeFileSync(path.join(directory, ".dev.vars"), "OPENAI_API_KEY=unrelated-secret\n");

    const source = createReactRouterWorkerPreviewDevVars({
      wranglerConfigPath,
      secretNames: ["AUTH_ADMIN_GRANT_TOKEN"],
    });

    assert.isNull(source);
  });
});

function createTemporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "backoffice-preview-dev-vars-"));
  temporaryDirectories.push(directory);
  return directory;
}
