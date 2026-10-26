// Bytes a forwarded body reads ahead of its client, so the upstream object keeps sending while
// earlier bytes are still on their way instead of waiting for each chunk to be read.
const FORWARDED_BODY_BUFFER_BYTES = 1024 * 1024;

const forwardedResponses = new WeakSet<Response>();

/**
 * Forwards a response body while cancelling upstream work when the owning request disconnects.
 * A response this already forwarded is returned as is: its owner was derived from the same request
 * and shares its signal, and copying every chunk through a second stream doubles the CPU per chunk.
 */
export function forwardRequestOwnedResponse(request: Request, response: Response): Response {
  if (!response.body || forwardedResponses.has(response)) {
    return response;
  }

  const upstreamReader = response.body.getReader();
  let released = false;
  let cancellation: Promise<void> | undefined;

  const releaseUpstreamReader = () => {
    if (released) {
      return;
    }
    released = true;
    request.signal.removeEventListener("abort", cancelForRequestAbort);
    upstreamReader.releaseLock();
  };

  const cancelUpstreamResponse = (reason: unknown): Promise<void> => {
    cancellation ??= upstreamReader
      .cancel(reason)
      .catch(() => {})
      .finally(releaseUpstreamReader);
    return cancellation;
  };

  const cancelForRequestAbort = () => {
    void cancelUpstreamResponse(request.signal.reason);
  };

  if (request.signal.aborted) {
    cancelForRequestAbort();
  } else {
    request.signal.addEventListener("abort", cancelForRequestAbort, { once: true });
  }

  // Workerd's native pipe could move the bytes without JavaScript, but it notices neither an
  // aborted request nor a cancelled client while upstream is idle, so cancellation stays here.
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await upstreamReader.read();
          if (result.done) {
            releaseUpstreamReader();
            controller.close();
            return;
          }
          controller.enqueue(result.value as Uint8Array);
        } catch (error) {
          releaseUpstreamReader();
          controller.error(error);
        }
      },
      async cancel(reason) {
        await cancelUpstreamResponse(reason);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: FORWARDED_BODY_BUFFER_BYTES }),
  );

  const forwarded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  forwardedResponses.add(forwarded);
  return forwarded;
}
