import type { HeapProfileFrame } from "./heap-profile-source-locations";

type SamplingHeapProfileNode = {
  id: number;
  selfSize: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  children: SamplingHeapProfileNode[];
};

type SamplingHeapProfile = {
  head: SamplingHeapProfileNode;
  samples: Array<{ nodeId: number; size: number; ordinal: number }>;
};

type ProfileNode = { node: SamplingHeapProfileNode; parentId: number | null };

type AllocationGroup = { label: string; bytes: number; samples: number };

/** Sampled allocation bytes, not retained heap; inclusive groups overlap by design. */
export type HeapAllocationAnalysis = {
  sampledBytes: number;
  resolvedBytes: number;
  unresolvedBytes: number;
  unresolvedSamples: number;
  treeSelfBytes: number;
  samples: number;
  selfAllocators: AllocationGroup[];
  modules: AllocationGroup[];
  projectOwners: AllocationGroup[];
  inclusiveProjectFrames: AllocationGroup[];
  ownedCallPaths: AllocationGroup[];
  unattributedBytes: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function requireSamplingHeapProfile(input: unknown): {
  profile: SamplingHeapProfile;
  nodes: Map<number, ProfileNode>;
  treeSelfBytes: number;
} {
  if (!isObject(input) || !isObject(input["head"]) || !Array.isArray(input["samples"])) {
    throw new Error("Heap profile must contain a head node and samples array.");
  }
  const nodes = new Map<number, ProfileNode>();
  const pending: Array<{ value: unknown; parentId: number | null }> = [
    { value: input["head"], parentId: null },
  ];
  let treeSelfBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !isObject(current.value)) {
      throw new Error("Heap profile contains an invalid call-tree node.");
    }
    const { id, selfSize, callFrame, children } = current.value;
    if (
      !isSafeInteger(id) ||
      !isNonNegativeNumber(selfSize) ||
      !isObject(callFrame) ||
      typeof callFrame["functionName"] !== "string" ||
      typeof callFrame["url"] !== "string" ||
      !isSafeInteger(callFrame["lineNumber"]) ||
      !isSafeInteger(callFrame["columnNumber"]) ||
      !Array.isArray(children)
    ) {
      throw new Error("Heap profile contains an invalid call-tree node.");
    }
    if (nodes.has(id)) {
      throw new Error(`Heap profile contains duplicate node ID ${id}.`);
    }
    const node = current.value as SamplingHeapProfileNode;
    nodes.set(node.id, { node, parentId: current.parentId });
    treeSelfBytes += node.selfSize;
    for (const child of node.children) {
      pending.push({ value: child, parentId: node.id });
    }
  }
  for (const sample of input["samples"]) {
    if (
      !isObject(sample) ||
      !isSafeInteger(sample["nodeId"]) ||
      !isNonNegativeNumber(sample["size"]) ||
      !isSafeInteger(sample["ordinal"])
    ) {
      throw new Error("Heap profile contains an invalid allocation sample.");
    }
  }
  return { profile: input as SamplingHeapProfile, nodes, treeSelfBytes };
}

function addAllocation(
  group: Map<string, AllocationGroup>,
  label: string,
  bytes: number,
  count: number,
) {
  const current = group.get(label);
  if (current) {
    current.bytes += bytes;
    current.samples += count;
  } else {
    group.set(label, { label, bytes, samples: count });
  }
}

function sortedAllocations(group: Map<string, AllocationGroup>): AllocationGroup[] {
  return [...group.values()].sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
}

function formatFrame(frame: HeapProfileFrame): string {
  return `${frame.functionName || "(anonymous)"} ${frame.file}:${frame.line}:${frame.column}`;
}

function allocationModule(frame: HeapProfileFrame): string {
  if (frame.kind === "project") {
    return frame.file.split("/").slice(0, 2).join("/");
  }
  if (frame.kind === "dependency") {
    const pnpmPackage = /node_modules\/\.pnpm\/((?:@[^+]+\+)?[^@/]+)@/.exec(frame.file);
    return `dependency:${pnpmPackage?.[1]?.replace("+", "/") ?? "other"}`;
  }
  return frame.file.startsWith("node:") ? "node:runtime" : "(native/anonymous)";
}

/** Attribute each sample once to its leaf allocator and nearest project-owned stack frame. */
export function analyzeHeapAllocationProfile(
  input: unknown,
  resolveFrame: (frame: SamplingHeapProfileNode["callFrame"]) => HeapProfileFrame,
): HeapAllocationAnalysis {
  const { profile, nodes, treeSelfBytes } = requireSamplingHeapProfile(input);
  const samplesByNode = new Map<number, { bytes: number; count: number }>();
  for (const sample of profile.samples) {
    const current = samplesByNode.get(sample.nodeId);
    if (current) {
      current.bytes += sample.size;
      current.count += 1;
    } else {
      samplesByNode.set(sample.nodeId, { bytes: sample.size, count: 1 });
    }
  }

  const frames = new Map<number, HeapProfileFrame>();
  const frameFor = (node: ProfileNode): HeapProfileFrame => {
    const cached = frames.get(node.node.id);
    if (cached) {
      return cached;
    }
    const frame = resolveFrame(node.node.callFrame);
    frames.set(node.node.id, frame);
    return frame;
  };
  const selfAllocators = new Map<string, AllocationGroup>();
  const modules = new Map<string, AllocationGroup>();
  const projectOwners = new Map<string, AllocationGroup>();
  const inclusiveProjectFrames = new Map<string, AllocationGroup>();
  const ownedCallPaths = new Map<string, AllocationGroup>();
  let unresolvedBytes = 0;
  let unresolvedSamples = 0;
  let unattributedBytes = 0;
  let sampledBytes = 0;

  for (const [nodeId, sample] of samplesByNode) {
    sampledBytes += sample.bytes;
    const leaf = nodes.get(nodeId);
    if (!leaf) {
      unresolvedBytes += sample.bytes;
      unresolvedSamples += sample.count;
      continue;
    }
    const allocator = frameFor(leaf);
    addAllocation(selfAllocators, formatFrame(allocator), sample.bytes, sample.count);
    addAllocation(modules, allocationModule(allocator), sample.bytes, sample.count);

    let owner: HeapProfileFrame | null = null;
    const projectFrames = new Set<string>();
    let current: ProfileNode | undefined = leaf;
    while (current) {
      const frame = frameFor(current);
      if (frame.kind === "project") {
        const label = formatFrame(frame);
        owner ??= frame;
        projectFrames.add(label);
      }
      current = current.parentId === null ? undefined : nodes.get(current.parentId);
    }
    for (const label of projectFrames) {
      addAllocation(inclusiveProjectFrames, label, sample.bytes, sample.count);
    }
    if (owner) {
      const label = formatFrame(owner);
      addAllocation(projectOwners, label, sample.bytes, sample.count);
      addAllocation(
        ownedCallPaths,
        owner === allocator ? label : `${label} ← ${formatFrame(allocator)}`,
        sample.bytes,
        sample.count,
      );
    } else {
      unattributedBytes += sample.bytes;
    }
  }

  return {
    sampledBytes,
    resolvedBytes: sampledBytes - unresolvedBytes,
    unresolvedBytes,
    unresolvedSamples,
    treeSelfBytes,
    samples: profile.samples.length,
    selfAllocators: sortedAllocations(selfAllocators),
    modules: sortedAllocations(modules),
    projectOwners: sortedAllocations(projectOwners),
    inclusiveProjectFrames: sortedAllocations(inclusiveProjectFrames),
    ownedCallPaths: sortedAllocations(ownedCallPaths),
    unattributedBytes,
  };
}
