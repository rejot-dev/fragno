import { assert, describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

import { DynamicWorkerExecutor } from "./codemode-executor";
import {
  collectBareSpecifiers,
  resolveNpmModules,
  rewriteCodeImports,
} from "./resolve-npm-modules";

/**
 * A hermetic stand-in for esm.sh. Serves a tiny multi-file "package" so the test
 * exercises the real resolution paths — the `?bundle-deps` facade re-export and an
 * absolute `/...` cross-module import — without touching the network. Shapes mirror
 * what esm.sh actually returns.
 */
function makeFakeEsmSh(files: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = files[url.pathname + url.search] ?? files[url.pathname];
    if (body === undefined) {
      return new Response(`not found: ${url.pathname}`, { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
  }) as typeof fetch;
}

const LEFTPAD = {
  "/leftpad@1.0.0?bundle-deps&target=es2022": `export { default } from "/leftpad@1.0.0/es2022/leftpad.bundle.mjs";`,
  "/leftpad@1.0.0/es2022/leftpad.bundle.mjs": `export default (s, n, c = " ") => String(s).padStart(n, c);`,
};

describe("resolveNpmModules", () => {
  test("builds a self-consistent module map from the esm.sh bundle graph", async () => {
    const { modules, imports } = await resolveNpmModules(["leftpad"], {
      pins: { leftpad: "leftpad@1.0.0" },
      fetchImpl: makeFakeEsmSh(LEFTPAD),
    });

    // every module key is Worker-Loader-legal (ends in .js)
    for (const key of Object.keys(modules)) {
      expect(key.endsWith(".js"), key).toBe(true);
    }
    // the requested specifier maps to a real module
    const entryKey = imports.leftpad;
    expect(modules[entryKey]).toBeDefined();
    // the facade's absolute import was rewritten to a relative in-map key
    const innerSpec = /from "([^"]+)"/.exec(modules[entryKey])?.[1];
    expect(innerSpec).toMatch(/^\.\//);
    const innerKey = innerSpec!.replace(/^\.\//, "");
    expect(modules[innerKey]).toContain("padStart");
  });

  test("end-to-end: a codemode snippet can import() the resolved package", async () => {
    const code = `async () => {
      const leftpad = (await import("leftpad")).default;
      return leftpad("7", 3, "0");
    }`;

    // 1. discover specifiers, 2. resolve to a module map, 3. rewrite the snippet.
    const specs = collectBareSpecifiers(code);
    expect(specs).toEqual(["leftpad"]);

    const { modules, imports } = await resolveNpmModules(specs, {
      pins: { leftpad: "leftpad@1.0.0" },
      fetchImpl: makeFakeEsmSh(LEFTPAD),
    });
    const rewritten = rewriteCodeImports(code, imports);
    expect(rewritten).not.toContain(`import("leftpad")`);

    const executor = new DynamicWorkerExecutor({ loader: env.LOADER, modules });
    const result = await executor.execute(rewritten, {});

    expect(result.error).toBeUndefined();
    assert(result.result === "007");
  });

  test("resolves a cross-module (absolute path) dependency graph end-to-end", async () => {
    const fetchImpl = makeFakeEsmSh({
      // entry package depends on a second package via an absolute esm.sh path
      "/greeter@2.0.0?bundle-deps&target=es2022":
        `import { shout } from "/util@1.0.0/es2022/util.bundle.mjs";\n` +
        `export const greet = (n) => shout("hello " + n);`,
      "/util@1.0.0/es2022/util.bundle.mjs": `export const shout = (s) => s.toUpperCase() + "!";`,
    });

    const code = `async () => {
      const { greet } = await import("greeter");
      return greet("world");
    }`;

    const { modules, imports } = await resolveNpmModules(["greeter"], {
      pins: { greeter: "greeter@2.0.0" },
      fetchImpl,
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER, modules });
    const result = await executor.execute(rewriteCodeImports(code, imports), {});

    expect(result.error).toBeUndefined();
    assert(result.result === "HELLO WORLD!");
  });

  test("normalizes an `npm:` prefixed specifier end-to-end", async () => {
    const code = `async () => {
      const leftpad = (await import("npm:leftpad")).default;
      return leftpad("7", 3, "0");
    }`;

    // collected as the in-code form, fetched from esm.sh without the npm: prefix
    const specs = collectBareSpecifiers(code);
    expect(specs).toEqual(["npm:leftpad"]);

    const { modules, imports } = await resolveNpmModules(specs, {
      pins: { leftpad: "leftpad@1.0.0" },
      fetchImpl: makeFakeEsmSh(LEFTPAD),
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER, modules });
    const result = await executor.execute(rewriteCodeImports(code, imports), {});

    expect(result.error).toBeUndefined();
    assert(result.result === "007");
  });

  test("does not detect non-literal (variable) dynamic imports", () => {
    // import(spec) where spec is a variable cannot be resolved on Worker Loader,
    // because the module set is fixed before the worker starts.
    const code = `async () => { const spec = "lodash"; return import(spec); }`;
    expect(collectBareSpecifiers(code)).toEqual([]);
  });

  test("throws a clear error when esm.sh 404s", async () => {
    await expect(
      resolveNpmModules(["does-not-exist"], { fetchImpl: makeFakeEsmSh({}) }),
    ).rejects.toThrow(/returned 404/);
  });
});
