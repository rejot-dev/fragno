import type { RouterContextProvider } from "react-router";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import {
  getGitHubDurableObject,
  getGitHubWebhookRouterDurableObject,
} from "@/cloudflare/cloudflare-utils";

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toStringValue = (value: unknown) => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
};

const getWebhookLogContext = (request: Request) => ({
  deliveryId: request.headers.get("x-github-delivery") ?? "",
  event: request.headers.get("x-github-event") ?? "",
  method: request.method,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toHex = (bytes: Uint8Array) =>
  bytes.reduce((acc, byte) => acc + byte.toString(16).padStart(2, "0"), "");

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};

const verifyWebhookSignature = async ({
  payloadBytes,
  signatureHeader,
  secret,
}: {
  payloadBytes: Uint8Array;
  signatureHeader: string | null;
  secret: string;
}) => {
  if (!signatureHeader) {
    return false;
  }

  const [scheme, digest] = signatureHeader.split("=", 2);
  if (scheme !== "sha256" || !digest) {
    return false;
  }

  const normalizedDigest = digest.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedDigest)) {
    return false;
  }

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const payloadBuffer =
    payloadBytes.buffer instanceof ArrayBuffer
      ? payloadBytes.buffer.slice(
          payloadBytes.byteOffset,
          payloadBytes.byteOffset + payloadBytes.byteLength,
        )
      : payloadBytes.slice().buffer;
  const expected = await crypto.subtle.sign("HMAC", hmacKey, payloadBuffer);
  const expectedHex = toHex(new Uint8Array(expected));

  return timingSafeEqual(expectedHex, normalizedDigest);
};

const getInstallationIdFromPayload = (payload: unknown) => {
  if (!isRecord(payload)) {
    return "";
  }

  const installation = isRecord(payload["installation"]) ? payload["installation"] : null;
  const nestedInstallationId = toStringValue(installation?.["id"]);
  if (nestedInstallationId) {
    return nestedInstallationId;
  }

  return toStringValue(payload["installation_id"]);
};

const extractWebhookPayload = async (request: Request) => {
  const payloadBuffer = await request.clone().arrayBuffer();
  const payloadBytes = new Uint8Array(payloadBuffer);
  const payloadText = textDecoder.decode(payloadBytes);
  if (!payloadText) {
    return { installationId: "", payloadText: "", payloadBytes, parseError: false };
  }

  try {
    const payload = JSON.parse(payloadText) as unknown;
    return {
      installationId: getInstallationIdFromPayload(payload),
      payloadText,
      payloadBytes,
      parseError: false,
    };
  } catch {
    return { installationId: "", payloadText, payloadBytes, parseError: true };
  }
};

const forwardWebhook = async (request: Request, context: Readonly<RouterContextProvider>) => {
  const webhookMeta = getWebhookLogContext(request);
  const { installationId, payloadText, payloadBytes, parseError } =
    await extractWebhookPayload(request);
  const { env } = context.get(CloudflareContext);

  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim() ?? "";
  if (!webhookSecret) {
    console.error("GitHub webhook secret is not configured", webhookMeta);
    return jsonResponse(
      {
        message: "GitHub webhook secret is not configured.",
        code: "WEBHOOK_SECRET_NOT_CONFIGURED",
      },
      500,
    );
  }

  const signatureValid = await verifyWebhookSignature({
    payloadBytes,
    signatureHeader: request.headers.get("x-hub-signature-256"),
    secret: webhookSecret,
  });
  if (!signatureValid) {
    console.warn("GitHub webhook rejected due to invalid signature", {
      ...webhookMeta,
      parseError,
      payloadSize: payloadText.length,
    });
    return jsonResponse(
      {
        message: "Invalid webhook signature.",
        code: "WEBHOOK_SIGNATURE_INVALID",
      },
      401,
    );
  }

  if (!installationId) {
    console.warn("GitHub webhook missing installation id", {
      ...webhookMeta,
      parseError,
      payloadSize: payloadText.length,
    });
    return jsonResponse(
      {
        message: "Missing installation id in webhook payload.",
        code: "WEBHOOK_INSTALLATION_ID_MISSING",
      },
      400,
    );
  }

  const githubWebhookRouterDo = getGitHubWebhookRouterDurableObject(context);
  const orgId = await githubWebhookRouterDo.getInstallationOrg(installationId);
  if (!orgId) {
    console.warn("GitHub webhook rejected because installation mapping was not found", {
      ...webhookMeta,
      installationId,
      parseError,
      payloadSize: payloadText.length,
    });

    return jsonResponse(
      {
        message:
          "No organisation mapping found for installation id. Complete installation from backoffice first.",
        code: "INSTALLATION_ORG_MAPPING_NOT_FOUND",
        installationId,
      },
      404,
    );
  }

  const githubDo = getGitHubDurableObject(context, orgId);
  const url = new URL(request.url);
  url.pathname = "/api/github/webhooks";
  url.searchParams.set("orgId", orgId);

  const proxyRequest = new Request(url.toString(), request);
  const response = await githubDo.fetch(proxyRequest);
  if (!response.ok) {
    console.warn("Forwarded GitHub webhook returned non-success status", {
      ...webhookMeta,
      installationId,
      orgId,
      status: response.status,
      statusText: response.statusText,
    });
  }

  return response;
};

export async function action({
  request,
  context,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}) {
  try {
    return await forwardWebhook(request, context);
  } catch (error) {
    console.error("GitHub webhook action handler failed", {
      ...getWebhookLogContext(request),
      error,
    });
    return jsonResponse(
      {
        message: "Webhook processing failed.",
        code: "WEBHOOK_PROCESSING_FAILED",
      },
      500,
    );
  }
}

export async function loader({
  request,
  context,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}) {
  try {
    return await forwardWebhook(request, context);
  } catch (error) {
    console.error("GitHub webhook loader handler failed", {
      ...getWebhookLogContext(request),
      error,
    });
    return jsonResponse(
      {
        message: "Webhook processing failed.",
        code: "WEBHOOK_PROCESSING_FAILED",
      },
      500,
    );
  }
}
