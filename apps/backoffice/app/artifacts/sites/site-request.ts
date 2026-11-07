import {
  ARTIFACT_SITE_RESPONSE_MAX_TEXT_BYTES,
  type ArtifactSiteRequestInput,
  type ArtifactSiteResponse,
} from "@fragno-dev/backoffice-api/v0/artifacts";

/** Where a request an agent sends appears to come from; a site's Worker sees only its path. */
const SITE_PROBE_ORIGIN = "https://backoffice.invalid";

/** Bodies of these types come back as text. */
const TEXT_TYPE =
  /^(?:text\/|application\/(?:json|javascript|xml|x-www-form-urlencoded)|image\/svg\+xml)|\+(?:json|xml)\b/iu;

/** The request an agent asked for, at the site-relative path it named. */
export function siteProbeRequest(input: ArtifactSiteRequestInput): Request {
  return new Request(new URL(input.url ?? "/", SITE_PROBE_ORIGIN), {
    method: input.method ?? "GET",
    headers: input.headers,
    body: input.body,
  });
}

/** Settles when `signal` aborts, and never otherwise. */
export function aborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve("aborted");
      },
      { once: true },
    );
  });
}

/**
 * What the agent learns of a site's answer: its status and headers, and its body as text when it
 * is text. The body is read until one byte past what is kept, or until `signal` aborts, and the
 * rest is cancelled, so a stream that stays open or a body of any size ends the read.
 */
export async function siteProbeResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Omit<ArtifactSiteResponse, "log">> {
  const type = response.headers.get("content-type");
  const kept = new Uint8Array(ARTIFACT_SITE_RESPONSE_MAX_TEXT_BYTES);
  let keptBytes = 0;
  let read = 0;
  let complete = true;
  let bodyError: string | null = null;
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (reader) {
    const stop = aborted(signal);
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array> | "aborted";
      try {
        next = await Promise.race([reader.read(), stop]);
      } catch (error) {
        // The status and headers were sent; the viewer gets what arrived before.
        bodyError = error instanceof Error ? error.message : String(error);
        complete = false;
        break;
      }
      if (next === "aborted") {
        complete = false;
        break;
      }
      if (next.done) {
        break;
      }
      read += next.value.byteLength;
      const room = kept.byteLength - keptBytes;
      if (room > 0) {
        kept.set(next.value.subarray(0, room), keptBytes);
        keptBytes += Math.min(room, next.value.byteLength);
      }
      if (read > kept.byteLength) {
        complete = false;
        break;
      }
    }
    if (!complete && bodyError === null) {
      // Not awaited: a stream may not settle its cancel.
      reader.cancel().catch(() => {});
    }
  }
  const status = response.status;
  const headers = Object.fromEntries(response.headers);
  const text = textOf(kept.subarray(0, keptBytes), type);
  if (text !== null) {
    return { status, headers, body: { text, truncated: !complete }, bodyError };
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  const bytes = complete ? read : Number.isSafeInteger(declared) ? declared : null;
  return { status, headers, body: { omitted: { type, bytes } }, bodyError };
}

/**
 * The body as text when its type is text, or when it has no type and is UTF-8. A body cut short
 * may end within a character, which is left out.
 */
function textOf(body: Uint8Array, type: string | null): string | null {
  if (type !== null && !TEXT_TYPE.test(type)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: type === null }).decode(body, { stream: true });
  } catch {
    return null;
  }
}
