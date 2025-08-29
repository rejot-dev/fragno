import { describe, expect, it } from "vitest";
import { parseContentType } from "./content-type";

describe("parseContentType", () => {
  it("should parse simple content types", () => {
    const result = parseContentType("application/json");
    expect(result).toEqual({
      type: "application",
      subtype: "json",
      mediaType: "application/json",
      parameters: {},
    });
  });

  it("should parse content types with parameters", () => {
    const result = parseContentType("application/x-ndjson; charset=utf-8");
    expect(result).toEqual({
      type: "application",
      subtype: "x-ndjson",
      mediaType: "application/x-ndjson",
      parameters: { charset: "utf-8" },
    });
  });

  it("should parse multiple parameters", () => {
    const result = parseContentType(
      "multipart/form-data; boundary=----WebKitFormBoundary; charset=utf-8",
    );
    expect(result).toEqual({
      type: "multipart",
      subtype: "form-data",
      mediaType: "multipart/form-data",
      parameters: {
        boundary: "----WebKitFormBoundary",
        charset: "utf-8",
      },
    });
  });

  it("should handle quoted parameter values", () => {
    const result = parseContentType('text/plain; charset="utf-8"');
    expect(result).toEqual({
      type: "text",
      subtype: "plain",
      mediaType: "text/plain",
      parameters: { charset: "utf-8" },
    });
  });

  it("should normalize to lowercase", () => {
    const result = parseContentType("Application/JSON; Charset=UTF-8");
    expect(result).toEqual({
      type: "application",
      subtype: "json",
      mediaType: "application/json",
      parameters: { charset: "UTF-8" },
    });
  });

  it("should handle extra whitespace", () => {
    const result = parseContentType("  text/html  ;  charset = utf-8  ");
    expect(result).toEqual({
      type: "text",
      subtype: "html",
      mediaType: "text/html",
      parameters: { charset: "utf-8" },
    });
  });

  it("should return null for invalid input", () => {
    expect(parseContentType("")).toBeNull();
    expect(parseContentType(null as unknown as string)).toBeNull();
    expect(parseContentType(undefined as unknown as string)).toBeNull();
    expect(parseContentType(123 as unknown as string)).toBeNull();
  });

  it("should return null for invalid media types", () => {
    expect(parseContentType("invalid")).toBeNull();
    expect(parseContentType("/")).toBeNull();
    expect(parseContentType("text/")).toBeNull();
    expect(parseContentType("/json")).toBeNull();
  });

  it("should handle parameters without values gracefully", () => {
    const result = parseContentType("text/plain; charset");
    expect(result).toEqual({
      type: "text",
      subtype: "plain",
      mediaType: "text/plain",
      parameters: {},
    });
  });

  it("should handle complex real-world examples", () => {
    const result = parseContentType("application/vnd.api+json; charset=utf-8; version=1");
    expect(result).toEqual({
      type: "application",
      subtype: "vnd.api+json",
      mediaType: "application/vnd.api+json",
      parameters: {
        charset: "utf-8",
        version: "1",
      },
    });
  });

  it("should handle text/event-stream", () => {
    const result = parseContentType("text/event-stream; charset=utf-8");
    expect(result).toEqual({
      type: "text",
      subtype: "event-stream",
      mediaType: "text/event-stream",
      parameters: { charset: "utf-8" },
    });
  });

  it("should parse application/octet-stream", () => {
    const result = parseContentType("application/octet-stream");
    expect(result).toEqual({
      type: "application",
      subtype: "octet-stream",
      mediaType: "application/octet-stream",
      parameters: {},
    });
  });

  it("should handle empty string parameters", () => {
    const result = parseContentType('text/plain; charset=""');
    expect(result).toEqual({
      type: "text",
      subtype: "plain",
      mediaType: "text/plain",
      parameters: { charset: "" },
    });
  });
});
