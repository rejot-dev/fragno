import type { HTTPMethod, RouteContentType } from "./api";

export type PreparedRequestBody = {
  body: BodyInit | undefined;
  contentType: string | null | undefined;
};

const isBinaryRequestBody = (body: unknown): body is BodyInit =>
  body instanceof ReadableStream ||
  body instanceof Blob ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body);

const containsFileBody = (value: unknown): boolean => {
  if (value instanceof File || value instanceof Blob || value instanceof FormData) {
    return true;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some(
      (entry) => entry instanceof File || entry instanceof Blob || entry instanceof FormData,
    )
  );
};

const appendFormDataValue = (formData: FormData, key: string, value: unknown) => {
  if (value instanceof File) {
    formData.append(key, value, value.name);
  } else if (value instanceof Blob) {
    formData.append(key, value);
  } else if (value !== undefined && value !== null) {
    formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
};

const prepareMultipartBody = (body: unknown): FormData => {
  if (body instanceof FormData) {
    return body;
  }

  const formData = new FormData();
  if (body instanceof File) {
    formData.append("file", body, body.name);
    return formData;
  }
  if (body instanceof Blob) {
    formData.append("file", body);
    return formData;
  }
  if (typeof body === "object" && body !== null) {
    for (const [key, value] of Object.entries(body)) {
      appendFormDataValue(formData, key, value);
    }
    return formData;
  }

  throw new TypeError("Multipart routes require FormData, File, Blob, or an object body.");
};

export const prepareRouteRequestBody = (
  body: unknown,
  contentType: RouteContentType = "application/json",
): PreparedRequestBody => {
  if (body === undefined) {
    return { body: undefined, contentType: undefined };
  }

  switch (contentType) {
    case "application/json":
      return { body: JSON.stringify(body), contentType };
    case "multipart/form-data":
      return { body: prepareMultipartBody(body), contentType: null };
    case "application/octet-stream":
      if (!isBinaryRequestBody(body)) {
        throw new TypeError(
          "Octet-stream routes require Blob, ArrayBuffer, ArrayBufferView, or ReadableStream bodies.",
        );
      }
      return { body, contentType };
    default:
      throw new TypeError("Unsupported route content type.");
  }
};

export const prepareClientRequestBody = (
  body: unknown,
  contentType?: RouteContentType,
): PreparedRequestBody => {
  if (body === undefined) {
    return { body: undefined, contentType: undefined };
  }

  if (contentType === "application/octet-stream") {
    if (!isBinaryRequestBody(body)) {
      throw new TypeError(
        "Octet-stream routes require Blob, ArrayBuffer, ArrayBufferView, or ReadableStream bodies.",
      );
    }
    return { body, contentType };
  }

  if (body instanceof FormData || body instanceof File || body instanceof Blob) {
    return { body: prepareMultipartBody(body), contentType: null };
  }
  if (containsFileBody(body)) {
    return { body: prepareMultipartBody(body), contentType: null };
  }

  return { body: JSON.stringify(body), contentType: "application/json" };
};

export const prepareInferredRequestBody = (body: unknown): PreparedRequestBody => {
  if (body === undefined) {
    return { body: undefined, contentType: undefined };
  }

  if (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    isBinaryRequestBody(body)
  ) {
    return { body, contentType: null };
  }

  return { body: JSON.stringify(body), contentType: "application/json" };
};

export const applyPreparedRequestBodyContentType = (
  headers: Headers,
  preparedBody: PreparedRequestBody,
) => {
  if (preparedBody.contentType === null) {
    headers.delete("content-type");
  } else if (preparedBody.contentType !== undefined) {
    headers.set("content-type", preparedBody.contentType);
  }
};

export const createRequestInitWithBody = (
  method: HTTPMethod,
  headers: HeadersInit,
  body: BodyInit | undefined,
  options: Omit<RequestInit, "method" | "headers" | "body"> = {},
): RequestInit & { duplex?: "half" } => {
  const requestInit: RequestInit & { duplex?: "half" } = {
    ...options,
    method,
    headers,
    body,
  };
  if (body instanceof ReadableStream) {
    requestInit.duplex = "half";
  }
  return requestInit;
};
