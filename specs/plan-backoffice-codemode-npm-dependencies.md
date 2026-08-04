# Backoffice Codemode npm Dependencies Plan

## Recommendation

Use a compiled `WorkerBundle` as the shared boundary:

```ts
type WorkerBundle = {
  mainModule: string;
  modules: Record<string, string>;
  runtime: {
    compatibilityDate: string;
    compatibilityFlags: string[];
  };
};
```

Then keep building, execution, and deployment separate:

```txt
Codemode source + npm dependencies
              │
              ▼
 @cloudflare/worker-bundler
              │
              ▼
        WorkerBundle
         │            │
         ▼            ▼
 Worker Loader     Cloudflare Fragment
 local execution   Workers for Platforms
```

**Do not create a generic “runner/deployer” interface.** Local execution and remote deployment have
different lifecycles. The bundle should be the shared abstraction.

Cloudflare’s own APIs follow this separation: Worker Loader consumes a code object for local dynamic
execution, while Workers for Platforms uploads metadata plus module files.
citeturn1fetch0turn1fetch1

---

## Problems in the current implementation

The current path in `apps/backoffice/app/fragno/codemode/`:

1. Regex-scans source.
2. Fetches packages from esm.sh.
3. Walks and rewrites the CDN graph.
4. Rewrites user imports.
5. Passes the CDN modules to Worker Loader.
6. Persists those rewritten modules for durable workflows.

Besides the CDN dependency, it has several undesirable semantics:

- Unversioned imports resolve to whatever esm.sh currently serves.
- CDN URL and module-layout behavior leaks into Backoffice.
- Package resolution is different from normal npm resolution.
- Direct codemode and workflow codemode have subtly different package behavior.
- The resulting module graph cannot cleanly become a Workers for Platforms deployment.

---

# Proposed implementation plan

## [x] Phase 1: Introduce the Worker bundle contract

The canonical bundle contract is owned by Backoffice for now:

```txt
apps/backoffice/app/backoffice-runtime/dynamic-workers/worker-bundle.ts
```

It contains only the data required to execute a compiled Worker:

- main module name;
- ESM module sources;
- compatibility date;
- compatibility flags.

`createWorkerBundle` validates the main module and runtime settings at construction. Format
versioning, hashing, byte counting, deployment conversion, and Worker Loader wrappers were omitted
until a concrete consumer requires them.

---

## [x] Phase 2: Add a Backoffice Worker compiler

Implemented in:

```txt
apps/backoffice/app/backoffice-runtime/dynamic-workers/compile-worker.ts
```

`@cloudflare/worker-bundler` is pinned exactly to `0.2.2` in Backoffice.

The compiler:

1. validates the entrypoint, dependency declarations, and compiler-owned paths;
2. creates an `InMemoryFileSystem`;
3. writes compiler-owned `package.json` and `wrangler.json` files;
4. runs `installDependencies` and promotes installation warnings to failures;
5. runs `createWorker({ bundle: true })`;
6. rejects non-ESM emitted modules;
7. constructs a `WorkerBundle`.

Module resolution belongs to `@cloudflare/worker-bundler`; Backoffice does not parse or regex-scan
JavaScript imports. Package compatibility failures surface through installation or bundling.
Dependency and output limits remain future hardening work.

---

## [x] Phase 3: Define package dependencies for codemode

`execCodeMode` and the development codemode route now accept:

```ts
{
  code: string;
  dependencies?: Record<string, string>;
}
```

Usage:

```ts
{
  code: `async () => {
    const { z } = await import("zod");
    return z.string().parse("hello");
  }`,
  dependencies: {
    zod: "4.3.5"
  }
}
```

The dependency boundary owns only package names and versions:

- keys must be unscoped or scoped npm package names;
- keys cannot be import specifiers or package subpaths;
- values must be non-empty, trimmed versions or version ranges.

Backoffice does not parse or validate source import specifiers for this API. During the temporary
esm.sh path, dependency declarations are converted to resolver pins. Phase 4 will pass the same map
to the Worker compiler as `package.json` dependencies.

---

## [x] Phase 4: Replace direct codemode execution

`DynamicWorkerExecutor` now has two responsibilities:

1. generate codemode Worker entrypoints;
2. execute compiled `WorkerBundle` values through Worker Loader.

The new flow becomes:

```txt
providers
   ↓
generate executor entrypoint
   ↓
compile with worker-bundler
   ↓
WorkerBundle
   ↓
Worker Loader
```

One-shot codemode now compiles the generated executor with `@cloudflare/worker-bundler` and uses
`env.LOADER.load(...)` for execution. The esm.sh resolver, import rewriting, prepared-code fields,
and named Worker Loader execution were deleted.

Workflow codemode temporarily persists dependency declarations and compiles its remote entrypoint on
replay. Phase 5 will replace that transitional behavior with a persisted compiled bundle.

---

## [ ] Phase 5: Make workflows artifact-based

This is the most important durability change.

Do **not** persist dependency ranges and rebuild on every workflow replay. Instead:

1. Build the evaluation Worker.
2. Execute it to discover whether it defines a workflow.
3. If it does, generate the remote-workflow entrypoint.
4. Build that entrypoint using the same installed filesystem.
5. Persist the compiled workflow artifact in workflow parameters.

Change:

```ts
type PiCodemodeWorkflowParams = {
  code: string;
  modules?: Record<string, string>;
  // ...
};
```

to roughly:

```ts
type PiCodemodeWorkflowParams = {
  sourceCode: string;
  worker: WorkerBundle;
  // ...
};
```

Then `runBackofficeCodemodeWorkflow` only loads the artifact. It must not contact npm or invoke
esbuild during replay.

This gives us:

- deterministic workflow code;
- no npm network request on replay;
- no package-version drift;
- faster workflow ticks;
- exactly the artifact that can later be deployed remotely.

Automation workflows should follow the same model: compile when the automation version is created or
changed, not during each execution.

---

## [ ] Phase 6: Add installation caching

Do this after correctness.

Use a build-workspace abstraction so the evaluation entrypoint and workflow entrypoint share the
same installed filesystem during one request.

Later, persist installed package trees using `DurableObjectKVFileSystem`, keyed by a hash of:

- normalized dependency manifest;
- worker-bundler version;
- compatibility flags;
- registry.

Do not cache `"latest"` indefinitely without incorporating the resolved version into the key.

---

# [ ] Workers for Platforms extension

When adding deployment support, change `@fragno-dev/cloudflare-fragment` to deploy `WorkerBundle`,
not raw source code.

## [ ] Contract change

Replace:

```ts
{
  script: {
    type: "esmodule";
    entrypoint: string;
    content: string;
  }
}
```

with:

```ts
{
  worker: WorkerBundle;
}
```

The fragment should remain a **publisher**, never a compiler.

## [ ] Persistence changes

Replace the current source-oriented fields:

- `sourceCode`
- `sourceByteLength`
- `format`
- `entrypoint`

with artifact-oriented fields:

- `artifact`
- `artifactHash`
- `artifactByteLength`
- `mainModule`
- `moduleCount`

Avoid duplicating the full bundle in the durable-hook payload. Store the immutable artifact with the
deployment and let the hook retrieve it before the external upload. The hook payload only needs
identifiers, expected ETag, and artifact hash.

## [ ] Upload changes

In `cloudflare-api.ts`:

- Convert every artifact module to a multipart `File`.
- Set `metadata.main_module` from `artifact.mainModule`.
- Take compatibility settings from the artifact.
- Preserve the existing deployment tags, ETag compare-and-swap, supersession, and reconciliation
  behavior.

Workers for Platforms supports multipart uploads consisting of metadata plus one or more Worker
modules, so the artifact maps naturally to the API. citeturn1fetch1

---

# Suggested implementation order

- [x] Add the Backoffice-owned `WorkerBundle` contract.
- [x] Add the exact `@cloudflare/worker-bundler` dependency.
- [x] Implement the workerd compiler adapter.
- [x] Add explicit codemode dependency declarations.
- [x] Migrate one-shot codemode and load the bundle directly with Worker Loader.
- [ ] Migrate Pi durable workflows to persisted bundles.
- [ ] Migrate automation workflows.
- [x] Delete the esm.sh resolver.
- [ ] Add dependency caching and limits.
- [ ] Later, update `cloudflare-fragment` to accept and upload the same bundle.

## Key acceptance tests

- [x] A package import compiles and executes without a CDN (`is-number@7.0.0` smoke test).
- [x] Exact package versions can be requested.
- [ ] Scoped packages and package subpaths work.
- [ ] Transitive dependencies work.
- [ ] Missing packages fail during build, not at Worker runtime.
- [ ] Sandbox egress policy remains unchanged.
- [ ] Workflow replay succeeds with npm access disabled.
- [ ] The same bundle runs through Worker Loader and can be submitted to the Cloudflare fragment.
- [x] No esm.sh references remain in Backoffice.
