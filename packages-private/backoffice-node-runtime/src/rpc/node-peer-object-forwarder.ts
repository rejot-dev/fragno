import { RpcTarget } from "capnweb";

/** Creates a lazy peer object target and rechecks authority around every forwarded RPC result. */
export function createNodePeerForwardingTarget(
  getObject: () => Promise<RpcTarget>,
  assertAuthority: () => void,
): RpcTarget {
  let objectPromise: Promise<RpcTarget> | null = null;
  let disposed = false;

  function resolveObjectStub() {
    objectPromise ??= getObject();
    return objectPromise.then((object) => {
      const objectStub = object as RpcTarget &
        Disposable &
        Record<string, (...args: unknown[]) => unknown>;
      if (disposed) {
        objectStub[Symbol.dispose]();
        throw new Error("NODE_PEER_RPC_OBJECT_TARGET_DISPOSED");
      }
      return objectStub;
    });
  }

  return new Proxy(new RpcTarget(), {
    get(target, property): unknown {
      const targetProperties = target as unknown as Record<PropertyKey, unknown>;
      if (property === Symbol.dispose) {
        return () => {
          if (disposed) {
            return;
          }
          disposed = true;
          if (objectPromise) {
            void objectPromise.then(
              (object) => {
                (object as RpcTarget & Disposable)[Symbol.dispose]();
              },
              () => {},
            );
          }
        };
      }
      if (typeof property !== "string" || property === "constructor") {
        return targetProperties[property];
      }
      if (property === "then" || property === "alarm") {
        return undefined;
      }
      if (property === "fetch") {
        return async (requestValue: unknown) => {
          assertAuthority();
          if (!(requestValue instanceof Request)) {
            throw new Error("NODE_PEER_RPC_FETCH_REQUEST_INVALID");
          }
          const objectStub = await resolveObjectStub();
          assertAuthority();
          const responseValue = await objectStub["fetch"](detachNodePeerRequest(requestValue));
          assertAuthority();
          if (!(responseValue instanceof Response)) {
            throw new Error("NODE_PEER_RPC_FETCH_RESPONSE_INVALID");
          }
          return detachNodePeerResponse(responseValue);
        };
      }
      return async (...args: unknown[]) => {
        assertAuthority();
        const objectStub = await resolveObjectStub();
        assertAuthority();
        const result = await objectStub[property](...args);
        assertAuthority();
        return result;
      };
    },
  });
}

function detachNodePeerRequest(request: Request): Request {
  const body = request.body
    ? detachNodePeerReadableStream(request.body as ReadableStream<Uint8Array>)
    : null;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    duplex: body ? "half" : undefined,
  } as RequestInit);
}

function detachNodePeerResponse(response: Response): Response {
  const body = response.body
    ? detachNodePeerReadableStream(response.body as ReadableStream<Uint8Array>)
    : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function detachNodePeerReadableStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
