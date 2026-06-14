import { RpcTarget } from "cloudflare:workers";

export type CodemodeToolDescriptor = {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execute(input: unknown, ...args: unknown[]): Promise<unknown> | unknown;
};

export type ToolProvider = {
  name: string;
  fns?: Record<string, (...args: unknown[]) => Promise<unknown> | unknown>;
  tools?: Record<string, CodemodeToolDescriptor>;
};

export type ResolvedProvider = {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

export type ExecuteResult = {
  result?: unknown;
  error?: string;
  logs?: string[];
  workflowDefinition?: { name: string; options?: unknown };
};

export type DynamicWorkerExecutorOptions = {
  loader: WorkerLoader;
  timeout?: number;
  globalOutbound?: Fetcher | null;
  modules?: Record<string, string>;
};

export type Executor = {
  execute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<ExecuteResult>;
};

export const normalizeCode = (code: string): string => code.trim();

export const sanitizeToolName = (name: string): string => {
  const sanitized = name.replace(/[^a-zA-Z0-9_$]/gu, "_");
  return /^[a-zA-Z_$]/u.test(sanitized) ? sanitized : `_${sanitized}`;
};

export const resolveProvider = (provider: ToolProvider): ResolvedProvider => {
  if (provider.fns) {
    return {
      name: provider.name,
      fns: Object.fromEntries(
        Object.entries(provider.fns).map(([name, fn]) => [
          name,
          async (...args: unknown[]) => await fn(...args),
        ]),
      ),
    };
  }

  return {
    name: provider.name,
    fns: Object.fromEntries(
      Object.entries(provider.tools ?? {}).map(([name, tool]) => [
        name,
        async (...args: unknown[]) => await tool.execute(args[0], ...args.slice(1)),
      ]),
    ),
  };
};

const CODEMODE_BINARY_TAG = "__codemode_binary_v1__";

type EncodedCodemodeBinary = {
  [CODEMODE_BINARY_TAG]: "Uint8Array" | "ArrayBuffer" | "ArrayBufferView";
  data: string;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.byteLength)),
    );
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const encodeCodemodeValue = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return { [CODEMODE_BINARY_TAG]: "Uint8Array", data: bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { [CODEMODE_BINARY_TAG]: "ArrayBuffer", data: bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      [CODEMODE_BINARY_TAG]: "ArrayBufferView",
      data: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  return value;
};

const isEncodedCodemodeBinary = (value: unknown): value is EncodedCodemodeBinary =>
  value !== null &&
  typeof value === "object" &&
  CODEMODE_BINARY_TAG in value &&
  typeof (value as { data?: unknown }).data === "string";

const decodeCodemodeValue = (value: unknown): unknown => {
  if (!isEncodedCodemodeBinary(value)) {
    return value;
  }

  const bytes = base64ToBytes(value.data);
  if (value[CODEMODE_BINARY_TAG] === "ArrayBuffer") {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return bytes;
};

const stringifyCodemodeValue = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) => encodeCodemodeValue(nested));

const parseCodemodeValue = (json: string): unknown =>
  JSON.parse(json, (_key, nested) => decodeCodemodeValue(nested));

export class ToolDispatcher extends RpcTarget {
  readonly #fns: Record<string, (...args: unknown[]) => Promise<unknown> | unknown>;

  constructor(fns: Record<string, (...args: unknown[]) => Promise<unknown> | unknown>) {
    super();
    this.#fns = fns;
  }

  async call(toolName: string, argsJson: string): Promise<string> {
    const fn = this.#fns[toolName];
    if (!fn) {
      return stringifyCodemodeValue({ error: `Unknown tool: ${toolName}` });
    }

    try {
      const args = parseCodemodeValue(argsJson) as unknown[];
      return stringifyCodemodeValue({ result: await fn(...args) });
    } catch (error) {
      return stringifyCodemodeValue({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
