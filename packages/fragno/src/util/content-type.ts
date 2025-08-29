/**
 * Represents a parsed content-type header
 */
export interface ParsedContentType {
  /** The main type (e.g., "application", "text", "image") */
  type: string;
  /** The subtype (e.g., "json", "html", "png") */
  subtype: string;
  /** The full media type (e.g., "application/json") */
  mediaType: string;
  /** Additional parameters like charset, boundary, etc. */
  parameters: Record<string, string>;
}

/**
 * Parses a content-type header string into its components
 *
 * @param contentType - The content-type header value to parse
 * @returns A ParsedContentType object or null if the input is invalid
 *
 * @example
 * ```ts
 * const { type, subtype, mediaType, parameters }
 *        = parseContentType("application/json; charset=utf-8");
 * console.assert(type === "application");
 * console.assert(subtype === "json");
 * console.assert(mediaType === "application/json");
 * console.assert(parameters["charset"] === "utf-8");
 */
export function parseContentType(contentType: string | null | undefined): ParsedContentType | null {
  if (!contentType || typeof contentType !== "string") {
    return null;
  }

  const trimmed = contentType.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(";").map((part) => part.trim());
  const mediaType = parts[0];

  if (!mediaType) {
    return null;
  }

  const typeParts = mediaType.split("/");
  if (typeParts.length !== 2) {
    return null;
  }

  const [type, subtype] = typeParts.map((part) => part.trim().toLowerCase());

  if (!type || !subtype) {
    return null;
  }

  const parameters: Record<string, string> = {};

  for (let i = 1; i < parts.length; i++) {
    const param = parts[i];
    const equalIndex = param.indexOf("=");

    if (equalIndex > 0) {
      const key = param.slice(0, equalIndex).trim().toLowerCase();
      let value = param.slice(equalIndex + 1).trim();

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      if (key) {
        parameters[key] = value;
      }
    }
  }

  return {
    type,
    subtype,
    mediaType: `${type}/${subtype}`,
    parameters,
  };
}
