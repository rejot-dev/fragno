# Least-commitment design

Use these examples when deciding whether a field, computation, option, normalization, result value,
or abstraction is required by the behavior being implemented.

## Find independent demand

A commitment is earned by at least one independent source:

- required observable behavior;
- a known domain invariant;
- an authoritative external or persistence contract;
- an operational acceptance criterion.

A caller, test, or helper introduced by the same change does not establish independent demand. Trace
through it and name what becomes incorrect or impossible without the commitment.

Choose the narrowest boundary that owns the requirement, and leave unrelated dimensions unspecified.
Judge semantic commitments rather than line count: retain types, validation, branches, and adapters
that express known behavior even when they make the implementation longer.

## Encode known states exactly

A richer type is appropriate when the domain already distinguishes the states:

```ts
type Job = { status: "queued"; startedAt: null } | { status: "running"; startedAt: Date };
```

This is preferable to a shorter shape that loses a known invariant:

```ts
type Job = {
  status: "queued" | "running";
  startedAt?: Date;
};
```

Exactness about known behavior is not speculation. The model remains silent about distinctions the
domain has not established.

## Put content identity at the boundary that identifies content

### Unowned identity

```ts
type WorkerBundle = {
  mainModule: string;
  modules: Record<string, string>;
  hash: string;
};

async function createWorkerBundle(input: WorkerBundleInput): Promise<WorkerBundle> {
  return { ...input, hash: await sha256(canonicalize(input)) };
}
```

Without a cache, deduplication key, signature, persistence identity, or deployment protocol, the
hash has no owner. It still fixes canonicalization semantics and makes construction asynchronous.

### Consumer-owned identity

```ts
function createWorkerBundle(input: WorkerBundleInput): WorkerBundle {
  return {
    mainModule: input.mainModule,
    modules: { ...input.modules },
  };
}
```

When a consumer requires content identity, define the digest inputs, algorithm, encoding, and
storage at that boundary.

## Version protocols when a protocol exists

A format marker belongs on persisted data, messages, files, or independently deployed boundaries
that must distinguish representations. A transient object with one producer and one consumer can
represent its current shape directly:

```ts
type WorkerBundle = {
  mainModule: string;
  modules: Record<string, string>;
};
```

Add a discriminator when a current decoder must select a representation or preserve compatibility
with existing data.

## Normalize only current semantics

Canonical sorting is required when order affects a current digest, signature, protocol, comparison,
or user-visible result. Deduplication may remain independently required even when sorting is not:

```ts
const modules = { ...input.modules };
const compatibilityFlags = [...new Set(input.compatibilityFlags)];
```

This makes no canonical-order promise while preserving the runtime meaning of repeated flags.

## Expose only current choices

Pass-through options create public policy before callers need to choose it:

```ts
type CompileWorkerInput = {
  files: Record<string, string>;
  build?: {
    target?: string;
    minify?: boolean;
    sourcemap?: boolean;
  };
};
```

Keep required fixed policy at the boundary that owns it and leave unrelated settings unspecified:

```ts
const build = await bundler.compile({
  files: input.files,
  target: "es2022",
});
```

Here `target` is present only when the current runtime contract requires it. Add another setting to
the input contract when required behavior gives a caller that choice.

## Return operation-owned results

A result contains the resolved values required by its current contract:

```ts
type CompiledWorker = {
  bundle: WorkerBundle;
};
```

Add package reporting, byte measurements, or diagnostics when a current audit view, limit, billing
rule, persistence record, or other observable behavior consumes them. Place each value at the
boundary that owns its semantics.

## Introduce contracts at current substitution boundaries

A forwarding interface around one implementation adds a stable abstraction without current
substitution behavior:

```ts
type WorkerCompiler = {
  compile(input: CompileWorkerInput): Promise<CompiledWorker>;
};

const workerCompiler: WorkerCompiler = {
  compile: compileWorkerWithCurrentBundler,
};
```

Expose the concrete operation until assembly, testing, or runtime behavior requires substitution:

```ts
export async function compileWorker(input: CompileWorkerInput): Promise<CompiledWorker> {
  // Current compiler behavior.
}
```

When substitution is required, define a contract containing only the operations shared by the
concrete collaborators.

## Review criterion

Every commitment names independent required behavior, a known invariant, an authoritative contract,
or an operational acceptance criterion. It lives at the narrowest boundary that owns it, and the
design leaves every unrelated dimension unspecified. Tests prove those requirements rather than
creating demand for otherwise unused behavior.
