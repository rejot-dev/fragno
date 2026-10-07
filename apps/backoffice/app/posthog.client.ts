import posthogClient, { type CaptureResult, type PostHog } from "posthog-js";

function redactAnalyticsValue(value: unknown, key: string): unknown {
  const property = key.replace(/^\$/, "");
  // The SDK can derive attribution properties from a URL independently of save_campaign_params.
  if (
    /(?:^|_)(?:utm_.+|(?:g|fb|ms|tw|tt)clid|mc_[ce]id|search_(?:engine|keyword))$/.test(property)
  ) {
    return undefined;
  }

  if (typeof value === "string") {
    const referrer = /(?:^|_)referrer$/.test(property);
    const frameUrl = property === "filename" || property === "abs_path";
    const pageUrl = /(?:^|_)url$/.test(property) || property === "href";
    if (referrer || pageUrl || frameUrl) {
      if (value === "") {
        return value;
      }
      // Preserve relative and virtual source filenames for stack-trace symbolication.
      if (frameUrl && !/^https?:\/\//i.test(value)) {
        return value.split(/[?#]/, 1)[0];
      }
      try {
        const url = referrer ? new URL(value) : new URL(value, window.location.origin);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          return undefined;
        }
        return referrer ? url.origin : `${url.origin}${url.pathname}`;
      } catch {
        return undefined;
      }
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactAnalyticsValue(item, ""));
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const properties = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(properties).map(([name, item]) => [name, redactAnalyticsValue(item, name)]),
      );
    }
  }
  return value;
}

function redactAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) {
    return null;
  }
  try {
    // Initial/person/session URLs may survive navigation in SDK persistence, so scrub the whole payload.
    return redactAnalyticsValue(event, "") as CaptureResult;
  } catch {
    console.warn("PostHog event dropped: URL redaction failed.");
    return null;
  }
}

export function initializePostHog(): PostHog | null {
  // Local preview serves the production build too, so the build target alone is insufficient.
  if (
    import.meta.env.BACKOFFICE_TARGET !== "cloudflare" ||
    !import.meta.env.PROD ||
    window.location.origin !== import.meta.env.VITE_POSTHOG_APP_ORIGIN
  ) {
    return null;
  }

  const projectToken = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;
  const host = import.meta.env.VITE_POSTHOG_HOST;
  if (!projectToken || !host) {
    console.error(
      "PostHog is disabled: configure VITE_POSTHOG_PROJECT_TOKEN and VITE_POSTHOG_HOST.",
    );
    return null;
  }

  try {
    posthogClient.init(projectToken, {
      api_host: host,
      defaults: "2026-05-30",
      before_send: redactAnalyticsEvent,
      save_campaign_params: false,
      save_referrer: false,
      disable_capture_url_hashes: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: true,
      capture_exceptions: {
        capture_unhandled_errors: true,
        capture_unhandled_rejections: true,
        capture_console_errors: false,
      },
    });
    return posthogClient;
  } catch {
    console.warn("PostHog initialization failed; continuing without browser analytics.");
    return null;
  }
}
