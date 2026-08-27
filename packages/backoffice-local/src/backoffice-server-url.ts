function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost") ||
    normalizedHostname === "[::1]"
  ) {
    return true;
  }

  const ipv4Octets = normalizedHostname.split(".");
  return (
    ipv4Octets.length === 4 &&
    ipv4Octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    ipv4Octets[0] === "127"
  );
}

/** Resolves an HTTPS Backoffice origin or an HTTP loopback development origin. */
export function resolveSecureBackofficeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Backoffice server URL is invalid: '${value}'.`, { cause: error });
  }

  if (url.username || url.password) {
    throw new Error("Backoffice server URL cannot contain credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Backoffice server URL must contain only an origin.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error("Backoffice server URL must use HTTPS unless it targets a loopback host.");
  }

  return url.origin;
}

/** Resolves an absolute OAuth endpoint owned by the selected Backoffice origin. */
export function resolveSameOriginBackofficeEndpoint({
  baseUrl,
  endpoint,
  label,
}: {
  baseUrl: string;
  endpoint: string;
  label: string;
}): string {
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch (error) {
    throw new Error(`Backoffice ${label} URL is invalid: '${endpoint}'.`, { cause: error });
  }

  if (endpointUrl.username || endpointUrl.password) {
    throw new Error(`Backoffice ${label} URL cannot contain credentials.`);
  }
  if (endpointUrl.origin !== baseUrl) {
    throw new Error(`Backoffice ${label} URL must use the selected Backoffice origin.`);
  }

  return endpointUrl.toString();
}

/** Fetches a Backoffice resource without forwarding a request through redirects. */
export async function fetchBackofficeWithoutRedirect(
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  return await fetch(input, { ...init, redirect: "manual" });
}
