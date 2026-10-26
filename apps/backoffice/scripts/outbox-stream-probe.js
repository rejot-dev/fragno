// Measures a scope's Automations outbox stream from a signed-in Backoffice tab. Paste it into the
// DevTools console, or evaluate it, then call:
//
//   await probeOutboxStream("org/<orgId>")   // or "user/<userId>"
//
// It runs three probes one after another and returns their results with UTC timestamps, so the
// server's `fragno.outbox_stream.completed` logs for the same window can be matched to them:
//
// - download: reads the whole outbox from the start, like a first catch-up without SQLite,
//   counting bytes and lines as they arrive, until `caught-up` or the server ends the response.
// - idle-cancel: opens the stream at the head, reads heartbeats for five seconds, then cancels the
//   body. The server should end that stream `aborted` within about a second.
// - catch-up-abort: opens the stream from the start and aborts the request after the first line.
//   The server should end it `aborted` within a few hundred milliseconds, mid-catch-up.
//
// `globalThis.outboxStreamProbeProgress` shows the running probe and how much it has read, and
// `globalThis.outboxStreamProbeStop()` ends every request it made.
// oxlint-disable-next-line no-unused-vars -- called by whoever evaluates this file
async function probeOutboxStream(scopePath, { maxDownloadMs = 120_000 } = {}) {
  const streamUrl = `/api/automations-scoped/${scopePath}/_internal/outbox/stream?limit=50&protocol=1`;
  const newline = 10;
  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  const progress = { probe: "download", bytes: 0, lines: 0 };
  globalThis.outboxStreamProbeProgress = progress;
  const stopAll = new AbortController();
  globalThis.outboxStreamProbeStop = () => {
    stopAll.abort();
  };

  /** Reads until `stop` returns true for a complete line, without keeping the body. */
  async function readLines(response, stop, deadline) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let lines = 0;
    let partial = [];
    let firstLine = null;
    let ended = "deadline";
    // A read that loses the race to the deadline still holds the next chunk, so it is kept.
    let pendingRead = null;
    while (performance.now() < deadline) {
      pendingRead ??= reader.read();
      let timer;
      const result = await Promise.race([
        pendingRead,
        new Promise((resolve) => {
          timer = setTimeout(resolve, deadline - performance.now());
        }),
      ]);
      clearTimeout(timer);
      if (!result) {
        break;
      }
      pendingRead = null;
      if (result.done) {
        ended = "server-closed";
        break;
      }
      const chunk = result.value;
      bytes += chunk.byteLength;
      progress.bytes = bytes;
      progress.lines = lines;
      let start = 0;
      let stopped = false;
      for (let index = chunk.indexOf(newline); index >= 0; index = chunk.indexOf(newline, start)) {
        lines += 1;
        // Only short lines are decoded: control frames and the first frame.
        const length = index - start + partial.reduce((sum, part) => sum + part.byteLength, 0);
        if (length < 512 || firstLine === null) {
          const text = decoder.decode(
            new Uint8Array([
              ...partial.flatMap((part) => [...part]),
              ...chunk.subarray(start, index),
            ]),
          );
          firstLine ??= JSON.parse(text);
          if (stop(JSON.parse(text))) {
            stopped = true;
          }
        }
        partial = [];
        start = index + 1;
        if (stopped) {
          break;
        }
      }
      if (stopped) {
        ended = "stopped";
        return { reader, bytes, lines, firstLine, ended };
      }
      if (start < chunk.byteLength) {
        partial.push(chunk.subarray(start));
      }
    }
    return { reader, bytes, lines, firstLine, ended };
  }

  /** Cancels a body, returning why it failed, so a failed cleanup shows up in the results. */
  async function cancelBody(reader) {
    try {
      await reader.cancel();
      return null;
    } catch (error) {
      return String(error);
    }
  }

  const results = {};

  // download
  {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const response = await fetch(streamUrl, { credentials: "include", signal: stopAll.signal });
    const ttfbMs = Math.round(performance.now() - t0);
    const read = await readLines(
      response,
      (frame) => frame.type === "caught-up" || frame.type === "rotate",
      t0 + maxDownloadMs,
    );
    const ms = performance.now() - t0;
    const cancelError = await cancelBody(read.reader);
    results.download = {
      startedAt,
      endedAt: new Date().toISOString(),
      status: response.status,
      contentEncoding: response.headers.get("content-encoding"),
      ended: read.ended,
      ttfbMs,
      ms: Math.round(ms),
      megabytes: +(read.bytes / 1e6).toFixed(1),
      megabytesPerSecond: +(read.bytes / 1e6 / (ms / 1000)).toFixed(1),
      lines: read.lines,
      head: read.firstLine?.catchUpTargetVersionstamp ?? null,
      cancelError,
    };
  }
  await sleep(1_500);

  // idle-cancel
  progress.probe = "idle-cancel";
  {
    const head = results.download.head;
    const response = await fetch(`${streamUrl}${head ? `&afterVersionstamp=${head}` : ""}`, {
      credentials: "include",
      signal: stopAll.signal,
    });
    const openedAt = new Date().toISOString();
    const read = await readLines(response, () => false, performance.now() + 5_000);
    const cancelledAt = new Date().toISOString();
    const cancelError = await cancelBody(read.reader);
    results.idleCancel = { openedAt, cancelledAt, lines: read.lines, cancelError };
  }
  await sleep(1_500);

  // catch-up-abort
  progress.probe = "catch-up-abort";
  {
    const controller = new AbortController();
    const response = await fetch(streamUrl, {
      credentials: "include",
      signal: AbortSignal.any([controller.signal, stopAll.signal]),
    });
    const openedAt = new Date().toISOString();
    const read = await readLines(response, () => true, performance.now() + 5_000);
    controller.abort();
    results.catchUpAbort = { openedAt, abortedAt: new Date().toISOString(), lines: read.lines };
  }

  progress.probe = "done";
  return results;
}
