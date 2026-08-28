/**
 * Forwards a response body while cancelling upstream work when the owning request disconnects.
 */
export function forwardRequestOwnedResponse(request: Request, response: Response): Response {
  if (!response.body) {
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

  const body = new ReadableStream<Uint8Array>({
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
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
