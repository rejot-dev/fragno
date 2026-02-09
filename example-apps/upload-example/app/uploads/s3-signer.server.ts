import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { Hash } from "@aws-sdk/hash-node";
import { formatUrl } from "@aws-sdk/util-format-url";
import type { S3Signer, S3SignerInput } from "@fragno-dev/upload";

type S3SignerConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint: string;
  bucket: string;
  pathStyle?: boolean;
  storageKeyPrefix?: string;
  allowedMethods?: readonly string[];
  allowedHeaders?: readonly string[];
  allowedHeaderPrefixes?: readonly string[];
};

const DEFAULT_ALLOWED_METHODS = ["GET", "PUT", "POST", "DELETE", "HEAD"] as const;
const DEFAULT_ALLOWED_HEADERS = ["content-type", "content-length", "content-md5"] as const;
const DEFAULT_ALLOWED_HEADER_PREFIXES = ["x-amz-checksum-", "x-amz-meta-"] as const;

const normalizePrefix = (prefix: string): string => {
  if (!prefix) {
    return "";
  }

  const segments = prefix.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error("Storage key prefix cannot include '.' or '..' segments");
    }
  }

  return segments.join("/");
};

const encodePathSegments = (value: string) =>
  value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const joinPathSegments = (...segments: (string | undefined)[]) => {
  const trimmed = segments.filter(Boolean).map((segment) => segment!.replace(/^\/+|\/+$/g, ""));
  return trimmed.join("/");
};

const buildAllowedPathPrefix = (config: S3SignerConfig, endpoint: URL) => {
  const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/+$/g, "");
  const baseSegment = basePath.replace(/^\/+|\/+$/g, "");
  const normalizedPrefix = normalizePrefix(config.storageKeyPrefix ?? "");
  const encodedPrefix = normalizedPrefix ? encodePathSegments(normalizedPrefix) : "";
  const path = joinPathSegments(
    baseSegment,
    config.pathStyle ? config.bucket : undefined,
    encodedPrefix,
  );
  return path ? `/${path}` : "/";
};

const buildAllowedHosts = (config: S3SignerConfig, endpoint: URL) => {
  const endpointHost = endpoint.hostname.toLowerCase();
  if (config.pathStyle) {
    return new Set([endpointHost]);
  }

  return new Set([`${config.bucket}.${endpointHost}`.toLowerCase()]);
};

const buildAllowedMethods = (config: S3SignerConfig) =>
  new Set((config.allowedMethods ?? DEFAULT_ALLOWED_METHODS).map((method) => method.toUpperCase()));

const buildAllowedHeaders = (config: S3SignerConfig) =>
  new Set((config.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS).map((header) => header.toLowerCase()));

const buildAllowedHeaderPrefixes = (config: S3SignerConfig) =>
  (config.allowedHeaderPrefixes ?? DEFAULT_ALLOWED_HEADER_PREFIXES).map((prefix) =>
    prefix.toLowerCase(),
  );

const buildRequest = (input: S3SignerInput, url: URL, headers: Record<string, string>) => {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }

  return new HttpRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    method: input.method,
    path: url.pathname,
    query: Object.keys(query).length > 0 ? query : undefined,
    headers: {
      host: url.host,
      ...headers,
    },
    body: input.body,
  });
};

const findHeaderKey = (headers: Record<string, string>, name: string): string | undefined => {
  const target = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === target);
};

export const createS3Signer = (config: S3SignerConfig): S3Signer => {
  const endpoint = new URL(config.endpoint);
  const allowedHosts = buildAllowedHosts(config, endpoint);
  const allowedMethods = buildAllowedMethods(config);
  const allowedHeaders = buildAllowedHeaders(config);
  const allowedHeaderPrefixes = buildAllowedHeaderPrefixes(config);
  const allowedPathPrefix = buildAllowedPathPrefix(config, endpoint);
  const endpointProtocol = endpoint.protocol;
  const endpointPort = endpoint.port;
  const signer = new SignatureV4({
    service: "s3",
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
    sha256: Hash.bind(null, "sha256"),
  });

  const assertAllowedMethod = (method: string) => {
    if (!allowedMethods.has(method.toUpperCase())) {
      throw new Error(`Signer refused to sign method ${method}`);
    }
  };

  const assertAllowedUrl = (url: URL) => {
    if (url.username || url.password) {
      throw new Error("Signer refused to sign URL with credentials");
    }

    if (url.protocol !== endpointProtocol) {
      throw new Error("Signer refused to sign URL with unexpected protocol");
    }

    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error("Signer refused to sign URL with unexpected host");
    }

    if (endpointPort) {
      if (url.port !== endpointPort) {
        throw new Error("Signer refused to sign URL with unexpected port");
      }
    } else if (url.port) {
      const defaultPort = endpointProtocol === "https:" ? "443" : "80";
      if (url.port !== defaultPort) {
        throw new Error("Signer refused to sign URL with unexpected port");
      }
    }

    if (allowedPathPrefix !== "/") {
      const path = url.pathname || "/";
      if (!(path === allowedPathPrefix || path.startsWith(`${allowedPathPrefix}/`))) {
        throw new Error("Signer refused to sign URL outside allowed prefix");
      }
    }
  };

  const sanitizeHeaders = (headers: Record<string, string> | undefined) => {
    if (!headers) {
      return {};
    }

    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (lower === "host") {
        continue;
      }

      if (allowedHeaders.has(lower)) {
        sanitized[key] = value;
        continue;
      }

      if (allowedHeaderPrefixes.some((prefix) => lower.startsWith(prefix))) {
        sanitized[key] = value;
      }
    }

    return sanitized;
  };

  return {
    sign: async (input) => {
      assertAllowedMethod(input.method);
      const url = new URL(input.url);
      assertAllowedUrl(url);
      const headers = sanitizeHeaders(input.headers);
      const signed = await signer.sign(buildRequest(input, url, headers));
      return {
        url: formatUrl(signed),
        headers: signed.headers as Record<string, string>,
      };
    },
    presign: async (input) => {
      assertAllowedMethod(input.method);
      const url = new URL(input.url);
      assertAllowedUrl(url);
      const headers: Record<string, string> = sanitizeHeaders(input.headers);
      // MinIO uses AWS SigV4 for authentication, and SigV4 presigned URLs use
      // the UNSIGNED-PAYLOAD hash for query-string auth when the payload isn't
      // known at signing time.
      // https://docs.min.io/enterprise/aistor-object-store/administration/iam/identity/oidc-identity/
      // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
      const sha256HeaderKey = findHeaderKey(headers, "x-amz-content-sha256");
      if (!sha256HeaderKey) {
        headers["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
      } else if (headers[sha256HeaderKey] !== "UNSIGNED-PAYLOAD") {
        headers[sha256HeaderKey] = "UNSIGNED-PAYLOAD";
      }

      const signed = await signer.presign(buildRequest(input, url, headers), {
        expiresIn: input.expiresInSeconds,
      });
      const responseHeaders = {
        ...headers,
        ...(signed.headers as Record<string, string>),
      };
      if (!findHeaderKey(responseHeaders, "x-amz-content-sha256")) {
        responseHeaders["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
      }
      return {
        url: formatUrl(signed),
        headers: responseHeaders,
      };
    },
  };
};
